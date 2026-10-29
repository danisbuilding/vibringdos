// Potluck API — Cloudflare Pages Functions + D1
// Bind your D1 database to the name "DB" in the Pages project settings.

const MAX_ACTIVE_EVENTS = 25;
const MAX_ITEMS = 100;
const MAX_CLAIMS_PER_ITEM = 40;
// Anonymous guest writes are the abuse surface, so they get the tight budget.
// Host writes are already gated by a secret key and need headroom for adding
// items one at a time.
const GUEST_WRITES_PER_MINUTE = 20;
const HOST_WRITES_PER_MINUTE = 120;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const fail = (status, message) => json({ error: message }, status);

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

function token(len) {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function clean(value, max) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.slice(0, max);
}

// Only these two values are ever stored; anything else becomes null rather
// than writing an arbitrary string that the client would render.
function temp(value) {
  const v = clean(value, 10);
  return v === "hot" || v === "cold" ? v : null;
}

function serves(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(999, n);
}

function qty(value, fallback = 1) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(99, Math.max(1, n));
}

// Per-IP write throttle. Cheap counter table, one row per IP per minute bucket.
async function throttled(db, request, tag, limit) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const bucket = Math.floor(Date.now() / 60000);
  const id = `${bucket}:${tag}:${ip}`;
  await db
    .prepare("INSERT INTO write_rate (id, bucket, n) VALUES (?, ?, 1) ON CONFLICT(id) DO UPDATE SET n = n + 1")
    .bind(id, bucket)
    .run();
  const row = await db.prepare("SELECT n FROM write_rate WHERE id = ?").bind(id).first();
  if (bucket % 30 === 0) {
    await db.prepare("DELETE FROM write_rate WHERE bucket < ?").bind(bucket - 5).run();
  }
  return row && row.n > limit;
}

// How many more of this item may still be claimed, ignoring one existing claim.
async function remainingFor(db, item, excludeClaimId = null) {
  const row = await db
    .prepare("SELECT COALESCE(SUM(qty_claimed), 0) AS taken FROM claims WHERE item_id = ? AND id IS NOT ?")
    .bind(item.id, excludeClaimId)
    .first();
  return item.qty_needed - row.taken;
}

// D1 returns { meta: { changes } }; the test shim mirrors that shape.
// A guarded write that writes nothing lost its race or broke an invariant.
function wrote(result) {
  return (result && result.meta && result.meta.changes) || 0;
}

async function hostByKey(db, key) {
  if (!key || key.length < 16) return null;
  return db.prepare("SELECT * FROM hosts WHERE host_key = ?").bind(key).first();
}

async function ownedEvent(db, eventId, key) {
  const host = await hostByKey(db, key);
  if (!host) return null;
  const event = await db
    .prepare("SELECT * FROM events WHERE id = ? AND host_id = ?")
    .bind(eventId, host.id)
    .first();
  return event ? { host, event } : null;
}

// Columns a guest may see. `note_to_host` is deliberately absent: it must never
// leave the server on a public request, so it is excluded from the SELECT
// rather than merely left unrendered by the client.
// Validated server-side: an unknown value falls back to forest rather than
// writing an arbitrary string that the client would put into the DOM.
const THEME_KEYS = ["forest","teal","ocean","indigo","plum","oxblood","chocolate","charcoal","burnt"];
const themeKey = (v) => (THEME_KEYS.includes(v) ? v : null);

const GUEST_CLAIM_COLS =
  "c.id, c.item_id, c.guest_name, c.qty_claimed, c.guest_note, " +
  "c.dish_name, c.serve_temp, c.serves, c.created_at";
const HOST_CLAIM_COLS = GUEST_CLAIM_COLS + ", c.note_to_host";

async function loadItems(db, eventId, audience = "host") {
  const items = (
    await db
      .prepare("SELECT * FROM items WHERE event_id = ? ORDER BY sort_order, created_at")
      .bind(eventId)
      .all()
  ).results;
  if (!items.length) return [];
  const cols = audience === "guest" ? GUEST_CLAIM_COLS : HOST_CLAIM_COLS;
  const claims = (
    await db
      .prepare(
        `SELECT ${cols} FROM claims c JOIN items i ON i.id = c.item_id
         WHERE i.event_id = ? ORDER BY c.created_at`
      )
      .bind(eventId)
      .all()
  ).results;
  const byItem = new Map();
  for (const c of claims) {
    if (!byItem.has(c.item_id)) byItem.set(c.item_id, []);
    byItem.get(c.item_id).push(c);
  }
  return items.map((i) => ({ ...i, claims: byItem.get(i.id) || [] }));
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const db = env.DB;
  const segs = (params.path || []).filter(Boolean);
  const method = request.method;
  const url = new URL(request.url);
  const key = url.searchParams.get("key");

  if (method !== "GET") {
    // Anonymous surfaces: claim create/edit/delete, and host-key minting.
    // Everything else carries a host key (in the path or the query string).
    const anon =
      segs[0] === "claims" ||
      (segs[0] === "items" && segs[2] === "claims") ||
      (segs[0] === "hosts" && segs.length === 1);
    try {
      const over = await throttled(db, request, anon ? "g" : "h",
        anon ? GUEST_WRITES_PER_MINUTE : HOST_WRITES_PER_MINUTE);
      if (over) return fail(429, "Too many changes too fast. Wait a minute and try again.");
    } catch {
      // A throttle-table failure must not take the app down.
    }
  }

  let body = {};
  if (method === "POST" || method === "PATCH") {
    try {
      body = await request.json();
    } catch {
      body = {};
    }
  }

  try {
    // ---- health ---------------------------------------------------------
    if (segs[0] === "health" && method === "GET") {
      let dbOk = false;
      let dbError = null;
      try {
        await db.prepare("SELECT 1 AS ok").first();
        dbOk = true;
      } catch (e) {
        dbError = String(e && e.message ? e.message : e);
      }
      return json({ ok: true, db_bound: !!db, db_query: dbOk, db_error: dbError });
    }

    // ---- hosts ----------------------------------------------------------
    if (segs[0] === "hosts" && segs.length === 1 && method === "POST") {
      const id = uid();
      const hostKey = token(32);
      await db
        .prepare("INSERT INTO hosts (id, host_key, email, created_at) VALUES (?, ?, ?, ?)")
        .bind(id, hostKey, clean(body.email, 200), now())
        .run();
      return json({ host_key: hostKey });
    }

    if (segs[0] === "hosts" && segs.length === 2 && method === "GET") {
      const host = await hostByKey(db, segs[1]);
      if (!host) return fail(404, "That host link isn't valid.");
      const events = (
        await db
          .prepare(
            `SELECT e.*,
                    (SELECT COUNT(*) FROM items i WHERE i.event_id = e.id) AS item_count,
                    (SELECT COALESCE(SUM(i.qty_needed), 0) FROM items i WHERE i.event_id = e.id) AS qty_needed,
                    (SELECT COALESCE(SUM(c.qty_claimed), 0) FROM claims c
                       JOIN items i ON i.id = c.item_id WHERE i.event_id = e.id) AS qty_claimed
             FROM events e WHERE e.host_id = ? ORDER BY e.archived, e.created_at DESC`
          )
          .bind(host.id)
          .all()
      ).results;
      return json({ email: host.email, events });
    }

    if (segs[0] === "hosts" && segs[2] === "events" && method === "POST") {
      const host = await hostByKey(db, segs[1]);
      if (!host) return fail(404, "That host link isn't valid.");
      const id = uid();
      const created = await db
        .prepare(
          `INSERT INTO events (id, host_id, slug, title, when_text, location, description, archived, theme, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, 0, ?, ?
           WHERE (SELECT COUNT(*) FROM events WHERE host_id = ? AND archived = 0) < ?`
        )
        .bind(
          id,
          host.id,
          token(12),
          clean(body.title, 120) || "Untitled gathering",
          clean(body.when_text, 120),
          clean(body.location, 200),
          clean(body.description, 1000),
          themeKey(body.theme),
          now(),
          host.id,
          MAX_ACTIVE_EVENTS
        )
        .run();
      if (!wrote(created))
        return fail(409, `You have ${MAX_ACTIVE_EVENTS} active gatherings. Archive one to add another.`);
      const event = await db.prepare("SELECT * FROM events WHERE id = ?").bind(id).first();
      return json({ event });
    }

    // ---- events (host) --------------------------------------------------
    if (segs[0] === "events" && segs.length === 2) {
      const owned = await ownedEvent(db, segs[1], key);
      if (!owned) return fail(404, "Gathering not found.");

      if (method === "GET") {
        return json({ event: owned.event, items: await loadItems(db, owned.event.id) });
      }

      if (method === "PATCH") {
        const e = owned.event;
        const nextArchived = "archived" in body ? (body.archived ? 1 : 0) : e.archived;
        const reviving = e.archived === 1 && nextArchived === 0;
        // Coming back from the archive consumes an active slot, so the cap is
        // re-checked inside the write rather than before it.
        const updated = await db
          .prepare(
            `UPDATE events SET title = ?, when_text = ?, location = ?, description = ?, archived = ?, theme = ?
             WHERE id = ?
               AND (? = 0 OR (SELECT COUNT(*) FROM events WHERE host_id = ? AND archived = 0) < ?)`
          )
          .bind(
            clean(body.title, 120) || e.title,
            "when_text" in body ? clean(body.when_text, 120) : e.when_text,
            "location" in body ? clean(body.location, 200) : e.location,
            "description" in body ? clean(body.description, 1000) : e.description,
            nextArchived,
            "theme" in body ? themeKey(body.theme) : e.theme,
            e.id,
            reviving ? 1 : 0,
            owned.host.id,
            MAX_ACTIVE_EVENTS
          )
          .run();
        if (!wrote(updated))
          return fail(409, `That would put you over ${MAX_ACTIVE_EVENTS} active gatherings. Archive another one first.`);
        const event = await db.prepare("SELECT * FROM events WHERE id = ?").bind(e.id).first();
        return json({ event });
      }

      if (method === "DELETE") {
        await db.prepare("DELETE FROM claims WHERE item_id IN (SELECT id FROM items WHERE event_id = ?)").bind(owned.event.id).run();
        await db.prepare("DELETE FROM items WHERE event_id = ?").bind(owned.event.id).run();
        await db.prepare("DELETE FROM events WHERE id = ?").bind(owned.event.id).run();
        return json({ ok: true });
      }
    }

    // ---- items ----------------------------------------------------------
    if (segs[0] === "events" && segs[2] === "items" && method === "POST") {
      const owned = await ownedEvent(db, segs[1], key);
      if (!owned) return fail(404, "Gathering not found.");
      const incoming = Array.isArray(body.items) ? body.items : [body];
      const maxOrder = await db
        .prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM items WHERE event_id = ?")
        .bind(owned.event.id)
        .first();
      let order = maxOrder.m;
      const stmts = [];
      for (const raw of incoming) {
        const name = clean(raw.name, 120);
        if (!name) continue;
        order += 1;
        stmts.push(
          db
            .prepare(
              `INSERT INTO items (id, event_id, name, qty_needed, host_note, sort_order, created_at)
               SELECT ?, ?, ?, ?, ?, ?, ?
               WHERE (SELECT COUNT(*) FROM items WHERE event_id = ?) < ?`
            )
            .bind(uid(), owned.event.id, name, qty(raw.qty_needed), clean(raw.host_note, 500), order, now(),
                  owned.event.id, MAX_ITEMS)
        );
      }
      if (!stmts.length) return fail(400, "Give the item a name.");
      const results = await db.batch(stmts);
      const added = results.reduce((n, r) => n + wrote(r), 0);
      if (added < stmts.length) {
        const room = await db
          .prepare("SELECT ? - COUNT(*) AS room FROM items WHERE event_id = ?")
          .bind(MAX_ITEMS, owned.event.id)
          .first();
        return fail(409, `A list holds ${MAX_ITEMS} items. ${added} added; room for ${Math.max(room.room, 0)} more.`);
      }
      return json({ items: await loadItems(db, owned.event.id) });
    }

    if (segs[0] === "items" && segs.length === 2) {
      const item = await db.prepare("SELECT * FROM items WHERE id = ?").bind(segs[1]).first();
      if (!item) return fail(404, "Item not found.");
      const owned = await ownedEvent(db, item.event_id, key);
      if (!owned) return fail(404, "Item not found.");

      if (method === "PATCH") {
        const want = "qty_needed" in body ? qty(body.qty_needed, item.qty_needed) : item.qty_needed;
        // The new figure must cover what guests have already promised. Edits that
        // leave the number alone are always allowed, so a list can still be fixed
        // if it ever ends up over-claimed.
        const updated = await db
          .prepare(
            `UPDATE items SET name = ?, qty_needed = ?, host_note = ?, sort_order = ?
             WHERE id = ?
               AND (? >= (SELECT COALESCE(SUM(qty_claimed), 0) FROM claims WHERE item_id = items.id)
                    OR ? >= items.qty_needed)`
          )
          .bind(
            clean(body.name, 120) || item.name,
            want,
            "host_note" in body ? clean(body.host_note, 500) : item.host_note,
            "sort_order" in body ? parseInt(body.sort_order, 10) || item.sort_order : item.sort_order,
            item.id,
            want,
            want
          )
          .run();
        if (!wrote(updated)) {
          const taken = await db
            .prepare("SELECT COALESCE(SUM(qty_claimed), 0) AS n FROM claims WHERE item_id = ?")
            .bind(item.id)
            .first();
          return fail(409, `${taken.n} already claimed, so you can't need fewer than ${taken.n}.`);
        }
        return json({ items: await loadItems(db, item.event_id) });
      }

      if (method === "DELETE") {
        await db.prepare("DELETE FROM claims WHERE item_id = ?").bind(item.id).run();
        await db.prepare("DELETE FROM items WHERE id = ?").bind(item.id).run();
        return json({ items: await loadItems(db, item.event_id) });
      }
    }

    // ---- guest view -----------------------------------------------------
    if (segs[0] === "public" && segs.length === 2 && method === "GET") {
      const event = await db.prepare("SELECT * FROM events WHERE slug = ?").bind(segs[1]).first();
      if (!event) return fail(404, "This link doesn't point to a gathering.");
      return json({
        event: {
          id: event.id,
          title: event.title,
          when_text: event.when_text,
          location: event.location,
          description: event.description,
          archived: event.archived,
          theme: event.theme,
        },
        items: await loadItems(db, event.id, "guest"),
      });
    }

    // ---- claims (open to any guest) -------------------------------------
    if (segs[0] === "items" && segs[2] === "claims" && method === "POST") {
      const item = await db.prepare("SELECT * FROM items WHERE id = ?").bind(segs[1]).first();
      if (!item) return fail(404, "That item is no longer on the list.");
      const name = clean(body.guest_name, 80);
      if (!name) return fail(400, "Add your name so the host knows who's bringing it.");
      const want = qty(body.qty_claimed);
      // One statement: the row only lands if the quantity still fits and the item
      // is under its sign-up cap. Two guests racing for the last slot -> one 409.
      const claimed = await db
        .prepare(
          `INSERT INTO claims (id, item_id, guest_name, qty_claimed, guest_note,
                               dish_name, serve_temp, serves, note_to_host, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE (SELECT COALESCE(SUM(qty_claimed), 0) FROM claims WHERE item_id = ?) + ?
                 <= (SELECT qty_needed FROM items WHERE id = ?)
             AND (SELECT COUNT(*) FROM claims WHERE item_id = ?) < ?`
        )
        .bind(uid(), item.id, name, want, clean(body.guest_note, 500),
              clean(body.dish_name, 120), temp(body.serve_temp), serves(body.serves),
              clean(body.note_to_host, 500), now(),
              item.id, want, item.id, item.id, MAX_CLAIMS_PER_ITEM)
        .run();
      if (!wrote(claimed)) {
        const full = await db.prepare("SELECT COUNT(*) AS n FROM claims WHERE item_id = ?").bind(item.id).first();
        if (full.n >= MAX_CLAIMS_PER_ITEM)
          return fail(409, "This item already has as many sign-ups as it can hold.");
        const left = await remainingFor(db, item);
        return fail(409, left > 0
          ? `Only ${left} of these still ${left === 1 ? "needs" : "need"} bringing.`
          : "Someone just claimed the last one.");
      }
      return json({ items: await loadItems(db, item.event_id, "guest") });
    }

    if (segs[0] === "claims" && segs.length === 2) {
      const claim = await db.prepare("SELECT * FROM claims WHERE id = ?").bind(segs[1]).first();
      if (!claim) return fail(404, "That sign-up was already removed.");
      const item = await db.prepare("SELECT * FROM items WHERE id = ?").bind(claim.item_id).first();
      if (!item) return fail(410, "The host removed that item.");

      if (method === "PATCH") {
        const want = "qty_claimed" in body ? qty(body.qty_claimed, claim.qty_claimed) : claim.qty_claimed;
        // Everyone else's total plus the new figure must still fit.
        const updated = await db
          .prepare(
            `UPDATE claims SET guest_name = ?, qty_claimed = ?, guest_note = ?,
                               dish_name = ?, serve_temp = ?, serves = ?, note_to_host = ?
             WHERE id = ?
               AND (SELECT COALESCE(SUM(qty_claimed), 0) FROM claims other
                    WHERE other.item_id = claims.item_id AND other.id <> claims.id) + ?
                   <= (SELECT qty_needed FROM items WHERE id = claims.item_id)`
          )
          .bind(
            clean(body.guest_name, 80) || claim.guest_name,
            want,
            "guest_note" in body ? clean(body.guest_note, 500) : claim.guest_note,
            "dish_name" in body ? clean(body.dish_name, 120) : claim.dish_name,
            "serve_temp" in body ? temp(body.serve_temp) : claim.serve_temp,
            "serves" in body ? serves(body.serves) : claim.serves,
            "note_to_host" in body ? clean(body.note_to_host, 500) : claim.note_to_host,
            claim.id,
            want
          )
          .run();
        if (!wrote(updated)) {
          const room = await remainingFor(db, item, claim.id);
          return fail(409, `Only ${room} of these still ${room === 1 ? "needs" : "need"} bringing.`);
        }
        return json({ items: await loadItems(db, item.event_id, "guest") });
      }

      if (method === "DELETE") {
        await db.prepare("DELETE FROM claims WHERE id = ?").bind(claim.id).run();
        return json({ items: await loadItems(db, item.event_id, "guest") });
      }
    }

    return fail(404, "No such endpoint.");
  } catch (err) {
    const ref = uid().slice(0, 8);
    console.error(`[${ref}] ${method} ${url.pathname}`, err && err.stack ? err.stack : err);
    return fail(500, `Something broke on the server (ref ${ref}). Try again.`);
  }
}

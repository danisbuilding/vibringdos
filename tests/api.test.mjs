// Integration tests for the API, run against an in-memory SQLite shim of D1.
//   node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { onRequest } from "../functions/api/[[path]].js";
import { onRequest as onImage } from "../functions/img/[[path]].js";

const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

// Four bytes is enough to be a valid JPEG as far as the sniff is concerned;
// the server never decodes the image.
const JPEG = (n = 64) => {
  const b = new Uint8Array(n);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  return b;
};
const NOT_JPEG = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG

/* ---- minimal R2 shim -------------------------------------------------- */
function fakeR2() {
  const store = new Map();
  return {
    store,
    async put(key, bytes) { store.set(key, Uint8Array.from(bytes)); },
    async get(key) {
      if (!store.has(key)) return null;
      const bytes = store.get(key);
      return { body: bytes, httpEtag: `"${key}"`, bytes };
    },
    async delete(key) { store.delete(key); },
  };
}

/* ---- minimal D1 shim ------------------------------------------------- */
function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => {
      const r = db.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return { prepare: (sql) => wrap(sql), batch: async (stmts) => Promise.all(stmts.map((s) => s.run())) };
}

/* ---- request helper --------------------------------------------------- */
let ipCounter = 0;
function client() {
  const DB = fakeD1();
  const IMG = fakeR2();
  const ip = `10.0.0.${++ipCounter}`; // unique IP per client keeps throttle buckets separate
  // A 4th argument varies the caller's IP, for tests that need more writes than
  // one address is allowed in a minute.
  const call = async (method, path, body, fromIp) => {
    const req = new Request("https://x.test/api/" + path, {
      method,
      headers: { "cf-connecting-ip": fromIp || ip, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const segs = path.split("?")[0].split("/").filter(Boolean);
    const res = await onRequest({ request: req, env: { DB, IMG }, params: { path: segs } });
    return { status: res.status, body: await res.json() };
  };

  // Image uploads carry raw bytes, not JSON.
  call.bytes = async (path, bytes) => {
    const req = new Request("https://x.test/api/" + path, {
      method: "POST",
      headers: { "cf-connecting-ip": ip, "content-type": "image/jpeg" },
      body: bytes,
    });
    const segs = path.split("?")[0].split("/").filter(Boolean);
    const res = await onRequest({ request: req, env: { DB, IMG }, params: { path: segs } });
    return { status: res.status, body: await res.json() };
  };

  // The /img/ route is a separate Function, so it is exercised separately.
  call.fetchImage = async (path) => {
    const req = new Request("https://x.test" + path, { method: "GET" });
    const segs = path.replace(/^\/img\//, "").split("/").filter(Boolean);
    const res = await onImage({ request: req, env: { IMG }, params: { path: segs } });
    return { status: res.status, cache: res.headers.get("cache-control"), type: res.headers.get("content-type") };
  };

  call.bucket = IMG;
  return call;
}

async function seeded(call, qty_needed = 2) {
  const { body: h } = await call("POST", "hosts", {});
  const key = h.host_key;
  const { body: e } = await call("POST", `hosts/${key}/events`, { title: "Sunday potluck" });
  const { body: i } = await call("POST", `events/${e.event.id}/items?key=${key}`, { name: "Bread", qty_needed });
  return { key, event: e.event, item: i.items[0] };
}

/* ---- tests ------------------------------------------------------------ */

test("host can create a gathering, add items, and guests see them by slug", async () => {
  const call = client();
  const { event, item } = await seeded(call);
  assert.equal(item.name, "Bread");
  const { status, body } = await call("GET", `public/${event.slug}`);
  assert.equal(status, 200);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].qty_needed, 2);
});

test("a guest cannot claim more than the item still needs", async () => {
  const call = client();
  const { item } = await seeded(call, 2);
  const over = await call("POST", `items/${item.id}/claims`, { guest_name: "Mallory", qty_claimed: 99 });
  assert.equal(over.status, 409);
  const ok = await call("POST", `items/${item.id}/claims`, { guest_name: "Ana", qty_claimed: 2 });
  assert.equal(ok.status, 200);
  const full = await call("POST", `items/${item.id}/claims`, { guest_name: "Tom", qty_claimed: 1 });
  assert.equal(full.status, 409);
});

test("partial fill accumulates across guests", async () => {
  const call = client();
  const { item, event } = await seeded(call, 3);
  await call("POST", `items/${item.id}/claims`, { guest_name: "Ana", qty_claimed: 1 });
  await call("POST", `items/${item.id}/claims`, { guest_name: "Jules", qty_claimed: 2 });
  const { body } = await call("GET", `public/${event.slug}`);
  const taken = body.items[0].claims.reduce((n, c) => n + c.qty_claimed, 0);
  assert.equal(taken, 3);
});

test("editing a claim cannot exceed what is left, excluding the claim itself", async () => {
  const call = client();
  const { item } = await seeded(call, 3);
  const { body: a } = await call("POST", `items/${item.id}/claims`, { guest_name: "Ana", qty_claimed: 1 });
  await call("POST", `items/${item.id}/claims`, { guest_name: "Jules", qty_claimed: 1 });
  const id = a.items[0].claims[0].id;
  const bad = await call("PATCH", `claims/${id}`, { qty_claimed: 3 });
  assert.equal(bad.status, 409);
  const good = await call("PATCH", `claims/${id}`, { qty_claimed: 2 }); // 2 + Jules' 1 = 3
  assert.equal(good.status, 200);
});

test("a wrong host key cannot read or edit someone else's gathering", async () => {
  const call = client();
  const { event } = await seeded(call);
  const bogus = "z".repeat(32);
  assert.equal((await call("GET", `events/${event.id}?key=${bogus}`)).status, 404);
  assert.equal((await call("PATCH", `events/${event.id}?key=${bogus}`, { title: "Hacked" })).status, 404);
  assert.equal((await call("DELETE", `events/${event.id}?key=${bogus}`)).status, 404);
  assert.equal((await call("POST", `events/${event.id}/items?key=${bogus}`, { name: "x" })).status, 404);
});

test("a short or missing host key is rejected outright", async () => {
  const call = client();
  assert.equal((await call("GET", "hosts/abc")).status, 404);
});

test("deleting an item removes its claims and leaves no orphans", async () => {
  const call = client();
  const { key, item } = await seeded(call);
  const { body: c } = await call("POST", `items/${item.id}/claims`, { guest_name: "Ana", qty_claimed: 1 });
  const claimId = c.items[0].claims[0].id;
  await call("DELETE", `items/${item.id}?key=${key}`);
  assert.equal((await call("PATCH", `claims/${claimId}`, { qty_claimed: 1 })).status, 404);
});

test("a claim on an item the host already deleted returns 410, not a crash", async () => {
  const call = client();
  const { item } = await seeded(call);
  const res = await call("POST", `items/${item.id.slice(0, -1)}q/claims`, { guest_name: "Ana" });
  assert.equal(res.status, 404);
});

test("a claim with no name is refused", async () => {
  const call = client();
  const { item } = await seeded(call);
  const res = await call("POST", `items/${item.id}/claims`, { guest_name: "   ", qty_claimed: 1 });
  assert.equal(res.status, 400);
});

test("the item cap is enforced on batch insert", async () => {
  const call = client();
  const { key, event } = await seeded(call);
  const many = Array.from({ length: 100 }, (_, i) => ({ name: "Item " + i }));
  const res = await call("POST", `events/${event.id}/items?key=${key}`, { items: many });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /100/);
});

test("the active gathering cap is enforced", async () => {
  const call = client();
  const { body: h } = await call("POST", "hosts", {});
  const key = h.host_key;
  for (let i = 0; i < 24; i++) await call("POST", `hosts/${key}/events`, { title: "E" + i });
  const last = await call("POST", `hosts/${key}/events`, { title: "25th" });
  assert.equal(last.status, 200);
  const over = await call("POST", `hosts/${key}/events`, { title: "26th" });
  assert.equal(over.status, 409);
});

test("unarchiving cannot push the host over the active cap", async () => {
  const call = client();
  const { body: h } = await call("POST", "hosts", {});
  const key = h.host_key;
  const ids = [];
  for (let i = 0; i < 25; i++) {
    const { body } = await call("POST", `hosts/${key}/events`, { title: "E" + i });
    ids.push(body.event.id);
  }
  // archive one, fill the freed slot, then try to revive the archived one
  await call("PATCH", `events/${ids[0]}?key=${key}`, { archived: true });
  const replacement = await call("POST", `hosts/${key}/events`, { title: "replacement" });
  assert.equal(replacement.status, 200);
  const revive = await call("PATCH", `events/${ids[0]}?key=${key}`, { archived: false });
  assert.equal(revive.status, 409);

  const { body: dash } = await call("GET", `hosts/${key}`);
  assert.equal(dash.events.filter((e) => !e.archived).length, 25);
});

test("a host cannot need fewer than guests have already claimed", async () => {
  const call = client();
  const { key, item } = await seeded(call, 3);
  await call("POST", `items/${item.id}/claims`, { guest_name: "Ana", qty_claimed: 3 });
  const res = await call("PATCH", `items/${item.id}?key=${key}`, { qty_needed: 1 });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /3 already claimed/);
  const ok = await call("PATCH", `items/${item.id}?key=${key}`, { qty_needed: 3 });
  assert.equal(ok.status, 200);
});

test("renaming an item leaves its quantity guard alone", async () => {
  const call = client();
  const { key, item } = await seeded(call, 2);
  await call("POST", `items/${item.id}/claims`, { guest_name: "Ana", qty_claimed: 2 });
  const res = await call("PATCH", `items/${item.id}?key=${key}`, { name: "Sourdough", host_note: "sliced" });
  assert.equal(res.status, 200);
  assert.equal(res.body.items[0].name, "Sourdough");
});

test("the batch insert stops exactly at the item cap", async () => {
  const call = client();
  const { key, event } = await seeded(call);   // 1 item already
  const many = Array.from({ length: 150 }, (_, i) => ({ name: "Item " + i }));
  const res = await call("POST", `events/${event.id}/items?key=${key}`, { items: many });
  assert.equal(res.status, 409);
  const { body } = await call("GET", `events/${event.id}?key=${key}`);
  assert.equal(body.items.length, 100);
});

test("the per-item sign-up cap is enforced by the write", async () => {
  const call = client();
  const { item } = await seeded(call, 99);
  for (let i = 0; i < 40; i++) {
    const res = await call("POST", `items/${item.id}/claims`, { guest_name: "G" + i, qty_claimed: 1 }, `10.7.0.${i}`);
    assert.equal(res.status, 200, `claim ${i} should land`);
  }
  const over = await call("POST", `items/${item.id}/claims`, { guest_name: "too many", qty_claimed: 1 }, "10.7.1.1");
  assert.equal(over.status, 409);
  assert.match(over.body.error, /sign-ups/);
});

test("writes are throttled per IP", async () => {
  const call = client();
  const { item } = await seeded(call, 99);
  let throttled = false;
  for (let i = 0; i < 40; i++) {
    const res = await call("POST", `items/${item.id}/claims`, { guest_name: "G" + i, qty_claimed: 1 });
    if (res.status === 429) { throttled = true; break; }
  }
  assert.ok(throttled, "expected a 429 within 40 writes");
});

test("reads are not throttled", async () => {
  const call = client();
  const { event } = await seeded(call);
  for (let i = 0; i < 40; i++) {
    const res = await call("GET", `public/${event.slug}`);
    assert.equal(res.status, 200);
  }
});

test("input is trimmed and capped, and quantities are clamped", async () => {
  const call = client();
  const { key, event } = await seeded(call);
  const { body } = await call("POST", `events/${event.id}/items?key=${key}`, {
    name: "  " + "x".repeat(300) + "  ",
    qty_needed: 5000,
  });
  const added = body.items[body.items.length - 1];
  assert.equal(added.name.length, 120);
  assert.equal(added.qty_needed, 99);
});

test("malformed JSON does not crash the handler", async () => {
  const DB = fakeD1();
  const req = new Request("https://x.test/api/hosts", {
    method: "POST",
    headers: { "cf-connecting-ip": "10.9.9.9", "content-type": "application/json" },
    body: "{not json",
  });
  const res = await onRequest({ request: req, env: { DB }, params: { path: ["hosts"] } });
  assert.equal(res.status, 200);
});

test("health reports the database binding", async () => {
  const call = client();
  const res = await call("GET", "health");
  assert.equal(res.status, 200);
  assert.equal(res.body.db_bound, true);
  assert.equal(res.body.db_query, true);
});

test("health reports a missing database instead of crashing", async () => {
  const req = new Request("https://x.test/api/health", { headers: { "cf-connecting-ip": "10.5.5.5" } });
  const res = await onRequest({ request: req, env: {}, params: { path: ["health"] } });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.db_bound, false);
  assert.equal(body.db_query, false);
});

test("a private note to the host NEVER reaches the guest payload", async () => {
  const call = client();
  const { event, item } = await seeded(call, 2);
  await call("POST", `items/${item.id}/claims`, {
    guest_name: "Tomás", dish_name: "Cornbread stuffing", serve_temp: "hot", serves: 8,
    guest_note: "needs the oven", note_to_host: "dairy-free this year please",
  });

  const pub = await call("GET", `public/${event.slug}`);
  const claim = pub.body.items[0].claims[0];

  // the key must be ABSENT, not empty — an empty string still ships the column
  assert.equal("note_to_host" in claim, false, "note_to_host must not be in the guest payload");
  assert.equal(JSON.stringify(pub.body).includes("dairy-free"), false,
    "the note text must appear nowhere in the public response");

  // and the public fields that should be there, are
  assert.equal(claim.dish_name, "Cornbread stuffing");
  assert.equal(claim.serve_temp, "hot");
  assert.equal(claim.serves, 8);
  assert.equal(claim.guest_note, "needs the oven");
});

test("the host does receive the private notes", async () => {
  const call = client();
  const { key, event, item } = await seeded(call, 2);
  await call("POST", `items/${item.id}/claims`, {
    guest_name: "Tomás", note_to_host: "dairy-free this year please",
  });
  const host = await call("GET", `events/${event.id}?key=${key}`);
  assert.equal(host.body.items[0].claims[0].note_to_host, "dairy-free this year please");
});

test("editing a claim does not leak the note back to guests", async () => {
  const call = client();
  const { event, item } = await seeded(call, 2);
  const { body } = await call("POST", `items/${item.id}/claims`, {
    guest_name: "Ana", note_to_host: "secret",
  });
  const id = body.items[0].claims[0].id;
  assert.equal("note_to_host" in body.items[0].claims[0], false, "POST response is a guest response");
  const edited = await call("PATCH", `claims/${id}`, { dish_name: "Pecan pie" });
  assert.equal("note_to_host" in edited.body.items[0].claims[0], false, "PATCH response is a guest response");
  assert.equal(edited.body.items[0].claims[0].dish_name, "Pecan pie");
});

test("serve_temp only ever stores hot or cold", async () => {
  const call = client();
  const { key, event, item } = await seeded(call, 4);
  for (const [sent, expected] of [["hot", "hot"], ["cold", "cold"], ["lukewarm", null], ["<script>", null]]) {
    const { body } = await call("POST", `items/${item.id}/claims`, {
      guest_name: "G" + sent, serve_temp: sent,
    });
    const last = body.items[0].claims[body.items[0].claims.length - 1];
    assert.equal(last.serve_temp, expected, `serve_temp ${sent}`);
  }
});

test("serves is clamped and rejects nonsense", async () => {
  const call = client();
  const { item } = await seeded(call, 5);   // one slot per value below
  for (const [sent, expected] of [[8, 8], [0, null], [-4, null], ["many", null], [99999, 999]]) {
    const { body } = await call("POST", `items/${item.id}/claims`, {
      guest_name: "S" + sent, serves: sent,
    });
    const last = body.items[0].claims[body.items[0].claims.length - 1];
    assert.equal(last.serves, expected, `serves ${sent}`);
  }
});

test("an unknown theme key is not stored", async () => {
  const call = client();
  const { body: h } = await call("POST", "hosts", {});
  const key = h.host_key;
  const ok = await call("POST", `hosts/${key}/events`, { title: "A", theme: "plum" });
  assert.equal(ok.body.event.theme, "plum");
  const bad = await call("POST", `hosts/${key}/events`, { title: "B", theme: "'; DROP TABLE--" });
  assert.equal(bad.body.event.theme, null);
});

test("the theme reaches the guest page", async () => {
  const call = client();
  const { body: h } = await call("POST", "hosts", {});
  const key = h.host_key;
  const { body: e } = await call("POST", `hosts/${key}/events`, { title: "A", theme: "burnt" });
  const pub = await call("GET", `public/${e.event.slug}`);
  assert.equal(pub.body.event.theme, "burnt");
});

test("unknown endpoints 404", async () => {
  const call = client();
  assert.equal((await call("GET", "nonsense")).status, 404);
});

/* ---- header image ----------------------------------------------------- */

test("a header image uploads, reaches the guest page, and serves cacheably", async () => {
  const call = client();
  const { key, event } = await seeded(call);

  const up = await call.bytes(`events/${event.id}/image?key=${key}`, JPEG());
  assert.equal(up.status, 200);
  assert.match(up.body.event.header_image, /^\/img\/[a-f0-9]+\/[a-z0-9]+\.jpg$/);

  // Stored under the path minus its leading slash.
  assert.equal(call.bucket.store.size, 1);
  assert.ok(call.bucket.store.has(up.body.event.header_image.slice(1)));

  const pub = await call("GET", `public/${event.slug}`);
  assert.equal(pub.body.event.header_image, up.body.event.header_image);

  const served = await call.fetchImage(up.body.event.header_image);
  assert.equal(served.status, 200);
  assert.equal(served.type, "image/jpeg");
  assert.match(served.cache, /immutable/);
});

test("a gathering with no image reports none, and the guest page says so", async () => {
  const call = client();
  const { event } = await seeded(call);
  const pub = await call("GET", `public/${event.slug}`);
  assert.equal(pub.body.event.header_image, null);
  assert.equal(call.bucket.store.size, 0);
});

test("the upload needs a valid host key", async () => {
  const call = client();
  const { event } = await seeded(call);
  const bad = await call.bytes(`events/${event.id}/image?key=${"z".repeat(32)}`, JPEG());
  assert.equal(bad.status, 404);
  assert.equal(call.bucket.store.size, 0, "nothing may be written without a host key");
});

test("non-JPEG bytes are rejected on their content, not their header", async () => {
  const call = client();
  const { key, event } = await seeded(call);
  const png = await call.bytes(`events/${event.id}/image?key=${key}`, NOT_JPEG());
  assert.equal(png.status, 415);
  assert.equal(call.bucket.store.size, 0);
});

test("an oversize upload is refused by the server, not just the editor", async () => {
  const call = client();
  const { key, event } = await seeded(call);
  const big = await call.bytes(`events/${event.id}/image?key=${key}`, JPEG(2 * 1024 * 1024 + 1));
  assert.equal(big.status, 413);
  assert.equal(call.bucket.store.size, 0);
});

test("replacing an image removes the object it replaced", async () => {
  const call = client();
  const { key, event } = await seeded(call);
  const first = await call.bytes(`events/${event.id}/image?key=${key}`, JPEG());
  const second = await call.bytes(`events/${event.id}/image?key=${key}`, JPEG(80));
  assert.notEqual(first.body.event.header_image, second.body.event.header_image);
  assert.equal(call.bucket.store.size, 1, "the replaced object must not linger");
  assert.ok(call.bucket.store.has(second.body.event.header_image.slice(1)));
});

test("removing the image clears the column and the object", async () => {
  const call = client();
  const { key, event } = await seeded(call);
  await call.bytes(`events/${event.id}/image?key=${key}`, JPEG());
  const gone = await call("DELETE", `events/${event.id}/image?key=${key}`);
  assert.equal(gone.status, 200);
  assert.equal(gone.body.event.header_image, null);
  assert.equal(call.bucket.store.size, 0);
  const pub = await call("GET", `public/${event.slug}`);
  assert.equal(pub.body.event.header_image, null);
});

test("deleting a gathering does not orphan its image", async () => {
  const call = client();
  const { key, event } = await seeded(call);
  await call.bytes(`events/${event.id}/image?key=${key}`, JPEG());
  assert.equal(call.bucket.store.size, 1);
  await call("DELETE", `events/${event.id}?key=${key}`);
  assert.equal(call.bucket.store.size, 0);
});

test("editing other details leaves the image alone", async () => {
  const call = client();
  const { key, event } = await seeded(call);
  const up = await call.bytes(`events/${event.id}/image?key=${key}`, JPEG());
  const patched = await call("PATCH", `events/${event.id}?key=${key}`, { title: "Renamed", theme: "plum" });
  assert.equal(patched.body.event.title, "Renamed");
  assert.equal(patched.body.event.header_image, up.body.event.header_image);
  assert.equal(call.bucket.store.size, 1);
});

test("the image route serves only the shape this app writes", async () => {
  const call = client();
  for (const path of ["/img/../secret.jpg", "/img/abc", "/img/abc/def.png", "/img/abc/d/e.jpg"]) {
    assert.equal((await call.fetchImage(path)).status, 404, path);
  }
});

test("uploads fail cleanly when no bucket is bound", async () => {
  const DB = fakeD1();
  const bare = async (method, path, body) => {
    const req = new Request("https://x.test/api/" + path, {
      method,
      headers: { "cf-connecting-ip": "10.9.9.9", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const res = await onRequest({ request: req, env: { DB }, params: { path: path.split("?")[0].split("/").filter(Boolean) } });
    return { status: res.status, body: await res.json() };
  };
  const { body: h } = await bare("POST", "hosts", {});
  const { body: e } = await bare("POST", `hosts/${h.host_key}/events`, { title: "A" });
  const req = new Request(`https://x.test/api/events/${e.event.id}/image?key=${h.host_key}`, {
    method: "POST",
    headers: { "cf-connecting-ip": "10.9.9.9", "content-type": "image/jpeg" },
    body: JPEG(),
  });
  const res = await onRequest({
    request: req,
    env: { DB },
    params: { path: ["events", e.event.id, "image"] },
  });
  assert.equal(res.status, 503);
});

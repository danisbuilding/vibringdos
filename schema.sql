-- Vibringdos — Friendsgiving potluck schema (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS hosts (
  id         TEXT PRIMARY KEY,
  host_key   TEXT NOT NULL UNIQUE,
  email      TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  host_id     TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  when_text   TEXT,
  location    TEXT,
  description TEXT,
  archived    INTEGER NOT NULL DEFAULT 0,
  -- Colour theme key; NULL = forest. See THEMES in index.html.
  theme       TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_host ON events(host_id);

CREATE TABLE IF NOT EXISTS items (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  qty_needed  INTEGER NOT NULL DEFAULT 1,
  host_note   TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_event ON items(event_id, sort_order);

CREATE TABLE IF NOT EXISTS claims (
  id          TEXT PRIMARY KEY,
  item_id     TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  guest_name  TEXT NOT NULL,
  qty_claimed INTEGER NOT NULL DEFAULT 1,
  guest_note  TEXT,
  dish_name    TEXT,        -- what the chef is actually bringing
  serve_temp   TEXT,        -- 'hot' | 'cold'
  serves       INTEGER,     -- how many people it feeds
  -- HOST-ONLY. Never appears in the public guest payload: it is excluded from
  -- the SELECT, not merely left unrendered by the client.
  note_to_host TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_item ON claims(item_id);

-- Per-IP write throttle counters. Rows are disposable; old buckets are swept
-- periodically by the API.
CREATE TABLE IF NOT EXISTS write_rate (
  id     TEXT PRIMARY KEY,  -- "<minute bucket>:<ip>"
  bucket INTEGER NOT NULL,
  n      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rate_bucket ON write_rate(bucket);

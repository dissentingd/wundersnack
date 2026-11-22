-- D1 schema for anonymous "Helped?" votes. One row per feed item; no user, device or IP data.
-- The Pages Functions create this table automatically on first use (lib/db.js); this file is for reference
-- or manual setup: npx wrangler d1 execute wundersnack-votes --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS votes (
  id      TEXT PRIMARY KEY,           -- feed item id, e.g. inat-68967630
  up      INTEGER NOT NULL DEFAULT 0,
  down    INTEGER NOT NULL DEFAULT 0,
  updated TEXT NOT NULL DEFAULT (datetime('now'))
);

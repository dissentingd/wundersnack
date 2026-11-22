// Shared by the Pages Functions. Creates the votes table on first use (once per isolate),
// so a fresh D1 database needs no manual schema step. Same definition as schema.sql.
let ready = null;
export function ensureSchema(db) {
  ready ??= db.prepare(
    `CREATE TABLE IF NOT EXISTS votes (
      id TEXT PRIMARY KEY, up INTEGER NOT NULL DEFAULT 0, down INTEGER NOT NULL DEFAULT 0,
      updated TEXT NOT NULL DEFAULT (datetime('now')))`
  ).run().catch(e => { ready = null; throw e; });
  return ready;
}

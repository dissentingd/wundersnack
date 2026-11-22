// wundersnack Worker: serves the static site (via the ASSETS binding) and the anonymous "Helped?" vote API.
//
//   POST /api/vote    body {"id": "<feed item id>", "v": 1|-1|0, "prev": 1|-1|0}
//                     One anonymous up/down for one item. Nothing about the voter is stored: no account,
//                     device id, cookie or IP. `prev` lets a person change or undo their vote. The app sends
//                     it as text/plain so browsers skip the CORS preflight (it's same-origin anyway).
//   GET  /api/totals  {"generated": "...", "items": {"<id>": {"up": n, "down": n}}} — public aggregate
//                     counts the weekly feed rebuild reads to rank and prune items.
//
// Only /api/* reaches this code (assets.run_worker_first in wrangler.jsonc); every other path is a static file.

const MAX_BODY = 512;
const PER_MINUTE = 30; // per client per isolate; in memory only, never persisted

let feedIds = null, feedIdsAt = 0;
let schemaReady = null;
const hits = new Map();

const json = (body, status = 200, cache = 'no-store') => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': cache },
});

// Creates the votes table on first use, so a fresh D1 database needs no manual step (same as schema.sql).
function ensureSchema(db) {
  schemaReady ??= db.prepare(
    `CREATE TABLE IF NOT EXISTS votes (
      id TEXT PRIMARY KEY, up INTEGER NOT NULL DEFAULT 0, down INTEGER NOT NULL DEFAULT 0,
      updated TEXT NOT NULL DEFAULT (datetime('now')))`
  ).run().catch(e => { schemaReady = null; throw e; });
  return schemaReady;
}

// Votes are only accepted for items that are actually in the current feed.
async function knownIds(request, env) {
  if (feedIds && Date.now() - feedIdsAt < 10 * 60 * 1000) return feedIds;
  const res = await env.ASSETS.fetch(new URL('/feed.json', request.url));
  const feed = await res.json();
  feedIds = new Set(feed.items.map(i => i.id));
  feedIdsAt = Date.now();
  return feedIds;
}

function limited(request) {
  const key = request.headers.get('CF-Connecting-IP') || 'local';
  const minute = Math.floor(Date.now() / 60000);
  const entry = hits.get(key);
  if (!entry || entry.minute !== minute) {
    if (hits.size > 5000) hits.clear();
    hits.set(key, { minute, n: 1 });
    return false;
  }
  return ++entry.n > PER_MINUTE;
}

async function vote(request, env) {
  if (limited(request)) return json({ error: 'slow down' }, 429);
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: 'too large' }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ error: 'bad json' }, 400); }

  const { id } = body;
  const v = Number(body.v), prev = Number(body.prev ?? 0);
  if (typeof id !== 'string' || ![1, -1, 0].includes(v) || ![1, -1, 0].includes(prev) || v === prev)
    return json({ error: 'bad vote' }, 400);
  if (!(await knownIds(request, env)).has(id)) return json({ error: 'unknown item' }, 404);

  await ensureSchema(env.DB);
  const dUp = (v === 1) - (prev === 1);
  const dDown = (v === -1) - (prev === -1);
  await env.DB.prepare(
    `INSERT INTO votes (id, up, down) VALUES (?1, max(?2, 0), max(?3, 0))
     ON CONFLICT(id) DO UPDATE SET up = max(up + ?2, 0), down = max(down + ?3, 0), updated = datetime('now')`
  ).bind(id, dUp, dDown).run();
  return json({ ok: true });
}

async function totals(env) {
  await ensureSchema(env.DB);
  const { results } = await env.DB.prepare('SELECT id, up, down FROM votes WHERE up + down > 0').all();
  const items = Object.fromEntries(results.map(r => [r.id, { up: r.up, down: r.down }]));
  return json({ generated: new Date().toISOString(), items }, 200, 'public, max-age=300');
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/vote' || pathname === '/api/totals') {
      if (!env.DB) return json({ error: 'votes not configured' }, 503);
      if (pathname === '/api/vote') return request.method === 'POST' ? vote(request, env) : json({ error: 'POST only' }, 405);
      return request.method === 'GET' ? totals(env) : json({ error: 'GET only' }, 405);
    }
    if (pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
    return env.ASSETS.fetch(request);
  },
};

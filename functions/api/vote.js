// POST /api/vote  body: {"id": "<feed item id>", "v": 1|-1|0, "prev": 1|-1|0}
// Records an anonymous up/down for one feed item. Nothing about the voter is stored:
// no account, device id, cookie or IP. `prev` lets a person change or undo their vote.
// Sent as text/plain so browsers skip the CORS preflight; same-origin in production anyway.

import { ensureSchema } from '../../lib/db.js';

const MAX_BODY = 512;
const PER_MINUTE = 30; // per client per isolate; in memory only, never persisted

let feedIds = null, feedIdsAt = 0;
const hits = new Map();

async function knownIds(context) {
  if (feedIds && Date.now() - feedIdsAt < 10 * 60 * 1000) return feedIds;
  const res = await context.env.ASSETS.fetch(new URL('/feed.json', context.request.url));
  const feed = await res.json();
  feedIds = new Set(feed.items.map(i => i.id));
  feedIdsAt = Date.now();
  return feedIds;
}

function limited(request) {
  const key = request.headers.get('CF-Connecting-IP') || 'local';
  const minute = Math.floor(Date.now() / 60000);
  const entry = hits.get(key);
  if (!entry || entry.minute !== minute) { hits.set(key, { minute, n: 1 }); return false; }
  if (hits.size > 5000) hits.clear();
  return ++entry.n > PER_MINUTE;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.DB) return json({ error: 'votes not configured' }, 503);
  if (limited(request)) return json({ error: 'slow down' }, 429);

  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: 'too large' }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ error: 'bad json' }, 400); }

  const { id } = body;
  const v = Number(body.v), prev = Number(body.prev ?? 0);
  if (typeof id !== 'string' || ![1, -1, 0].includes(v) || ![1, -1, 0].includes(prev) || v === prev)
    return json({ error: 'bad vote' }, 400);
  if (!(await knownIds(context)).has(id)) return json({ error: 'unknown item' }, 404);

  await ensureSchema(env.DB);
  const dUp = (v === 1) - (prev === 1);
  const dDown = (v === -1) - (prev === -1);
  await env.DB.prepare(
    `INSERT INTO votes (id, up, down) VALUES (?1, max(?2, 0), max(?3, 0))
     ON CONFLICT(id) DO UPDATE SET up = max(up + ?2, 0), down = max(down + ?3, 0), updated = datetime('now')`
  ).bind(id, dUp, dDown).run();
  return json({ ok: true });
}

export const onRequest = () => json({ error: 'POST only' }, 405);

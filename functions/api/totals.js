import { ensureSchema } from '../../lib/db.js';

// GET /api/totals -> {"generated": "...", "items": {"<id>": {"up": n, "down": n}, ...}}
// Public, anonymous aggregate counts. The feed builder reads this to rank and prune items.
export async function onRequestGet({ env }) {
  if (!env.DB) return new Response(JSON.stringify({ error: 'votes not configured' }), { status: 503 });
  await ensureSchema(env.DB);
  const { results } = await env.DB.prepare('SELECT id, up, down FROM votes WHERE up + down > 0').all();
  const items = Object.fromEntries(results.map(r => [r.id, { up: r.up, down: r.down }]));
  return new Response(JSON.stringify({ generated: new Date().toISOString(), items }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
  });
}

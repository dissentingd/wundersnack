#!/usr/bin/env node
// Which kinds of content actually help? Summarises the anonymous "Helped?" totals by source, topic and
// kind, and lists the most and least helpful items, to guide what to source next.
// Usage: node scripts/vote-report.mjs [totalsUrl]   (default: votes.totalsUrl in sources.config.json)
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(await readFile(path.join(root, 'sources.config.json'), 'utf8'));
const feed = JSON.parse(await readFile(path.join(root, 'feed.json'), 'utf8'));
const url = process.argv[2] || cfg.votes.totalsUrl;
const res = await fetch(url, { headers: { 'User-Agent': 'wundersnack-report/0.1' } });
if (!res.ok) { console.error(`${res.status} from ${url}`); process.exit(1); }
const totals = (await res.json()).items || {};

const byId = new Map(feed.items.map(i => [i.id, i]));
const score = (up, down) => (up + 1) / (up + down + 2);
const pct = x => `${Math.round(x * 100)}%`.padStart(4);

function table(title, keyOf) {
  const agg = new Map();
  for (const [id, t] of Object.entries(totals)) {
    const it = byId.get(id);
    if (!it) continue;
    const k = keyOf(it);
    const a = agg.get(k) || { up: 0, down: 0, items: 0 };
    a.up += t.up; a.down += t.down; a.items++;
    agg.set(k, a);
  }
  const rows = [...agg].sort((a, b) => score(b[1].up, b[1].down) - score(a[1].up, a[1].down));
  console.log(`\n${title}\n${'-'.repeat(title.length)}`);
  for (const [k, a] of rows)
    console.log(`${pct(score(a.up, a.down))} helped  ${String(a.up).padStart(5)} up ${String(a.down).padStart(5)} down  ${String(a.items).padStart(4)} items  ${k}`);
}

const voted = Object.keys(totals).length;
const all = Object.values(totals).reduce((s, t) => s + t.up + t.down, 0);
console.log(`${all} votes on ${voted} items (feed has ${feed.items.length})`);
table('By source', i => i.source);
table('By topic', i => i.topic || '(none)');
table('By kind', i => i.kind);

const ranked = Object.entries(totals).filter(([id, t]) => byId.has(id) && t.up + t.down >= 3)
  .map(([id, t]) => ({ id, ...t, s: score(t.up, t.down), title: byId.get(id).title }))
  .sort((a, b) => b.s - a.s);
const line = r => `${pct(r.s)}  ${r.up}/${r.up + r.down}  ${r.id}  ${r.title}`;
console.log('\nMost helpful (3+ votes)\n-----------------------');
ranked.slice(0, 15).forEach(r => console.log(line(r)));
console.log('\nLeast helpful (3+ votes)\n------------------------');
ranked.slice(-15).reverse().forEach(r => console.log(line(r)));

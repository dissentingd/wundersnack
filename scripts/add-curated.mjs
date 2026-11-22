#!/usr/bin/env node
// Add a YouTube or Vimeo video to curated.json, checked against the provider's oEmbed endpoint
// (confirms it exists and is embeddable, and fills in title + channel credit).
// Usage: node scripts/add-curated.mjs <url> "<why it's amazing, one or two sentences>" [topic]
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const [url, caption = '', topic = 'Curated'] = process.argv.slice(2);
if (!url) { console.error('usage: add-curated.mjs <url> "<caption>" [topic]'); process.exit(1); }

let provider, vid, oembed;
const yt = url.match(/(?:youtu\.be\/|v=|shorts\/|embed\/)([\w-]{11})/);
const vm = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
if (yt) { provider = 'youtube'; vid = yt[1]; oembed = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${vid}`)}`; }
else if (vm) { provider = 'vimeo'; vid = vm[1]; oembed = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(`https://vimeo.com/${vid}`)}`; }
else { console.error('Only YouTube and Vimeo links are supported.'); process.exit(1); }

const res = await fetch(oembed);
if (!res.ok) { console.error(`oEmbed said ${res.status}: video missing, private, or not embeddable.`); process.exit(1); }
const o = await res.json();

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'curated.json');
const data = JSON.parse(await readFile(file, 'utf8'));
const id = `${provider}-${vid}`;
if (data.items.some(i => i.id === id)) { console.error(`${id} is already curated.`); process.exit(1); }
data.items.push({
  id, source: provider === 'youtube' ? 'YouTube' : 'Vimeo', kind: 'embed', topic,
  title: o.title, subtitle: '', caption,
  media: { provider, id: vid, thumb: o.thumbnail_url, vertical: (o.height || 0) > (o.width || 1) },
  credit: o.author_name, license: 'Embedded from source',
  sourceUrl: provider === 'youtube' ? `https://www.youtube.com/watch?v=${vid}` : `https://vimeo.com/${vid}`,
});
await writeFile(file, JSON.stringify(data, null, 2) + '\n');
console.log(`Added ${id}: ${o.title} (${o.author_name})`);

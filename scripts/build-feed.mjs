#!/usr/bin/env node
// Builds feed.json from curated.json + open sources listed in sources.config.json.
// Media stays where it lives; feed.json only stores links, credits and licenses.
// Usage: node scripts/build-feed.mjs [--only=inaturalist,nasa,eso,commons]
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'wundersnack-feed/0.1 (+https://wundersnack.com)';
const cfg = JSON.parse(await readFile(path.join(root, 'sources.config.json'), 'utf8'));
// A JSON "\b" is a backspace character, not a regex word boundary ("\\b" is). Fail loudly rather than
// silently weakening the calm filter.
(function checkPatterns(node, where) {
  if (typeof node === 'string') {
    if (/[\x00-\x1f]/.test(node)) throw new Error(`sources.config.json ${where}: "${JSON.stringify(node)}" has a control character; write regex \\b as "\\\\b" in JSON`);
  } else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) checkPatterns(v, `${where}.${k}`);
})(cfg, 'config');
const onlyArg =process.argv.find(a => a.startsWith('--only='));
const only = onlyArg ? new Set(onlyArg.slice(7).split(',')) : null;
const want = s => !only || only.has(s);

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJSON(url, { delay = 0 } = {}) {
  if (delay) await sleep(delay);
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}
async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

const decode = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
const stripHtml = s => decode(String(s || '')).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
// First sentence(s) up to ~max chars, cut on a sentence boundary when possible.
function snippet(text, max = 220) {
  const t = stripHtml(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > 60 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '…';
}
const block = cfg.calmBlocklist.map(w => new RegExp(`\\b${w}`, 'i'));
const isCalm = (...texts) => {
  const t = texts.join(' ');
  return !block.some(re => re.test(t));
};
const nature = (cfg.commons.natureAllowlist || []).map(w => new RegExp(`\\b${w}`, 'i'));
const isNature = (...texts) => { const t = texts.join(' '); return !nature.length || nature.some(re => re.test(t)); };
// Wikipedia leads open with taxonomy ("X is a species of fungus in the family Y").
// Drop those sentences; return '' if nothing more interesting is left.
function speciesFact(summary) {
  const sentences = stripHtml(summary).split(/(?<=[.!?])\s+(?=[A-Z"“(])/).filter(s => s.length >= 40);
  const rest = sentences.filter(s => !/\b(is|are|was) an? ([\w-]+ )?(species|genus|family|order|subfamily|subspecies|tribe|class|phylum)\b/i.test(s)
    && !/\b(is|was) (native|endemic) to\b/i.test(s)
    && !/\b(described|circumscribed|transferred|reclassified|taxon|taxa|synonym|epithet|named (by|after)|classified|phylogenetic)\b/i.test(s) && !/\bfamily [A-Z]\w+(idae|aceae)\b/.test(s));
  return isCalm(rest.join(' ')) ? rest.join(' ').trim() : '';
}
// "(c) Jane Doe, some rights reserved (CC BY-NC)" -> "Jane Doe"
const cleanCredit = s => stripHtml(s).replace(/^\(c\)\s*/i, '')
  .replace(/,?\s*(some|no|all) rights reserved.*$/i, '').trim();
// "Hercostomus rogenhoferi - 2018-07-19" / "Nepenthes gracilis video2" -> tidy title
const cleanTitle = s => s.replace(/_/g, ' ').replace(/\s*[-–]\s*\d{4}-\d{2}-\d{2}$/, '')
  .replace(/\s+(video\s*)?\d{1,2}$/i, '').replace(/^\d{4}-\d{2}-\d{2}\s+/, '').trim();

const LICENSES = {
  'cc0': 'CC0', 'cc-by': 'CC BY', 'cc-by-nc': 'CC BY-NC', 'cc-by-sa': 'CC BY-SA',
  'cc-by-nc-sa': 'CC BY-NC-SA', 'cc-by-nd': 'CC BY-ND', 'cc-by-nc-nd': 'CC BY-NC-ND',
};

// ---------- iNaturalist: research-grade, most-faved photos per taxon ----------
async function fromINaturalist() {
  const c = cfg.inaturalist, out = [];
  for (const taxon of c.taxa) {
    const q = new URLSearchParams({
      taxon_id: taxon.id, quality_grade: 'research', photos: 'true',
      photo_license: c.photoLicenses.join(','), order_by: 'votes', per_page: String(c.perTaxon * 2),
      locale: 'en',
    });
    let res;
    try { res = await getJSON(`https://api.inaturalist.org/v1/observations?${q}`, { delay: 1100 }); }
    catch (e) { console.warn('iNat', taxon.label, e.message); continue; }
    const obs = res.results.filter(o => {
      const bad = (o.annotations || []).some(a => [19, 25, 27].includes(a.controlled_value_id)); // dead, scat, bone
      return !bad && o.photos?.length && o.photos[0].license_code && isCalm(o.description || '', o.taxon?.name || '', ...(o.tags || []));
    });
    // one photo per species keeps the feed varied
    const seen = new Set();
    for (const o of obs) {
      if (seen.has(o.taxon.id)) continue;
      seen.add(o.taxon.id);
      out.push({ o, taxon });
      if (seen.size >= c.perTaxon) break;
    }
  }
  // species facts: Wikipedia summaries via iNat's taxa endpoint, 30 ids per call
  const ids = [...new Set(out.map(x => x.o.taxon.id))];
  const facts = new Map();
  for (let i = 0; i < ids.length; i += 30) {
    try {
      const r = await getJSON(`https://api.inaturalist.org/v1/taxa/${ids.slice(i, i + 30).join(',')}?locale=en`, { delay: 1100 });
      for (const t of r.results) facts.set(t.id, t.wikipedia_summary || '');
    } catch (e) { console.warn('iNat taxa', e.message); }
  }
  return out.map(({ o, taxon }) => {
    const p = o.photos[0];
    const common = o.taxon.preferred_common_name;
    const fact = speciesFact(facts.get(o.taxon.id) || '');
    return {
      id: `inat-${o.id}`,
      source: 'iNaturalist',
      kind: 'image',
      topic: taxon.label,
      title: common ? common[0].toUpperCase() + common.slice(1) : o.taxon.name,
      subtitle: common ? o.taxon.name : '',
      caption: fact ? snippet(fact) : taxon.wonder,
      media: { src: p.url.replace('/square.', '/large.'), hi: p.url.replace('/square.', '/original.'), thumb: p.url.replace('/square.', '/small.') },
      credit: cleanCredit(p.attribution),
      license: LICENSES[p.license_code] || p.license_code,
      sourceUrl: `https://www.inaturalist.org/observations/${o.id}`,
      place: o.place_guess || '',
    };
  });
}

// ---------- NASA Image and Video Library ----------
async function fromNASA() {
  const c = cfg.nasa, out = [], seen = new Set();
  for (const query of c.queries) {
    let res;
    try {
      res = await getJSON(`https://images-api.nasa.gov/search?${new URLSearchParams({ q: query, media_type: 'image', page_size: String(c.perQuery * 2) })}`, { delay: 300 });
    } catch (e) { console.warn('NASA', query, e.message); continue; }
    let n = 0;
    for (const item of res.collection.items) {
      const d = item.data?.[0], href = item.links?.[0]?.href;
      if (!d || !href || seen.has(d.nasa_id)) continue;
      const desc = stripHtml(d.description);
      if (desc.length < 40) continue; // skip bare catalogue entries
      seen.add(d.nasa_id);
      // Not every asset has a ~medium rendition; read the manifest and take the best web size.
      let src, hi;
      try {
        const m = await getJSON(`https://images-api.nasa.gov/asset/${encodeURIComponent(d.nasa_id)}`, { delay: 150 });
        const hrefs = m.collection.items.map(x => x.href.replace(/^http:/, 'https:'));
        const pickImg = keys => keys.map(k => hrefs.find(h => h.includes(k) && /\.(jpe?g|png)$/i.test(h))).find(Boolean);
        src = pickImg(['~medium.', '~large.', '~small.', '~orig.']);
        hi = pickImg(['~large.', '~orig.']);
      } catch (e) { console.warn('NASA asset', d.nasa_id, e.message); }
      if (!src) continue;
      out.push({
        id: `nasa-${d.nasa_id}`,
        source: 'NASA',
        kind: 'image',
        topic: 'Space',
        title: stripHtml(d.title),
        subtitle: '',
        caption: snippet(desc),
        media: { src, ...(hi && hi !== src ? { hi } : {}), thumb: href },
        credit: stripHtml(d.secondary_creator || d.photographer || d.center || 'NASA'),
        license: 'Public domain (NASA)',
        sourceUrl: `https://images.nasa.gov/details/${encodeURIComponent(d.nasa_id)}`,
      });
      if (++n >= c.perQuery) break;
    }
  }
  return out;
}

// ---------- NASA videos: short clips only ----------
// Duration lives in each asset's metadata.json ("QuickTime:Duration": "0:02:12" or "12.5 s").
function parseDuration(v) {
  if (v == null) return NaN;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?\s*s$/.test(s)) return parseFloat(s);
  const parts = s.split(':').map(Number);
  return parts.some(isNaN) ? NaN : parts.reduce((a, b) => a * 60 + b, 0);
}
async function fromNASAVideo() {
  const c = cfg.nasaVideo, out = [], seen = new Set();
  const titleBlock = (c.titleBlocklist || []).map(w => new RegExp(`\\b${w}`, 'i'));
  for (const query of c.queries) {
    let res;
    try {
      res = await getJSON(`https://images-api.nasa.gov/search?${new URLSearchParams({ q: query, media_type: 'video', page_size: String(c.perQuery * 4) })}`, { delay: 300 });
    } catch (e) { console.warn('NASA video', query, e.message); continue; }
    let n = 0;
    for (const item of res.collection.items) {
      if (n >= c.perQuery) break;
      const d = item.data?.[0];
      if (!d || seen.has(d.nasa_id)) continue;
      seen.add(d.nasa_id);
      const title = stripHtml(d.title).replace(/_\d{3,4}p$/i, '').replace(/_/g, ' '), desc = stripHtml(d.description);
      const titleKey = title.toLowerCase().replace(/\s*[-–:]\s*(a|b|wide shot|close up|horizontal|vertical)$/i, '');
      if (seen.has(titleKey)) continue;
      seen.add(titleKey);
      if (titleBlock.some(re => re.test(title)) || !isCalm(title, desc) || desc.length < 40) continue;
      let hrefs, meta;
      try {
        const m = await getJSON(`https://images-api.nasa.gov/asset/${encodeURIComponent(d.nasa_id)}`, { delay: 150 });
        hrefs = m.collection.items.map(x => x.href.replace(/^http:/, 'https:'));
        const metaUrl = hrefs.find(h => h.endsWith('/metadata.json'));
        meta = metaUrl ? await getJSON(metaUrl.replace(/ /g, '%20'), { delay: 150 }) : {};
      } catch (e) { console.warn('NASA video asset', d.nasa_id, e.message); continue; }
      const duration = parseDuration(meta['QuickTime:Duration'] ?? meta['QuickTime:TrackDuration']);
      if (!(duration > 3 && duration <= c.maxDurationSeconds)) continue;
      const src = ['~mobile.mp4', '~small.mp4', '~preview.mp4', '~medium.mp4'].map(k => hrefs.find(h => h.endsWith(k))).find(Boolean);
      const poster = ['~medium.jpg', '~large.jpg', '~small.jpg', '~thumb.jpg'].map(k => hrefs.find(h => h.endsWith(k))).find(Boolean);
      if (!src) continue;
      const enc = u => u && encodeURI(decodeURI(u));
      out.push({
        id: `nasavid-${d.nasa_id}`,
        source: 'NASA',
        kind: 'video',
        topic: 'Space',
        title, subtitle: '',
        caption: snippet(desc),
        media: { sources: [{ src: enc(src), type: 'video/mp4' }], poster: enc(poster) || '', duration: Math.round(duration) },
        credit: stripHtml(d.secondary_creator || d.center || 'NASA'),
        license: 'Public domain (NASA)',
        sourceUrl: `https://images.nasa.gov/details/${encodeURIComponent(d.nasa_id)}`,
      });
      n++;
    }
  }
  return out;
}

// ---------- ESO press releases: new discoveries ----------
async function fromESO() {
  const c = cfg.eso;
  let xml;
  try { xml = await getText(c.feed); } catch (e) { console.warn('ESO', e.message); return []; }
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
  const tag = (s, t) => (s.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || '';
  return items.slice(0, c.max).flatMap(it => {
    const img = (it.match(/<enclosure[^>]*url="([^"]+)"/) || [])[1];
    const link = stripHtml(tag(it, 'link'));
    if (!img) return [];
    const date = new Date(stripHtml(tag(it, 'pubDate')));
    return [{
      id: `eso-${link.split('/').filter(Boolean).pop()}`,
      source: 'ESO',
      kind: 'image',
      topic: 'New discovery',
      title: stripHtml(tag(it, 'title')),
      subtitle: isNaN(date) ? '' : date.toISOString().slice(0, 10),
      caption: snippet(tag(it, 'description'), 260),
      media: { src: img, hi: img.replace('/screen/', '/large/'), thumb: img.replace('/screen/', '/thumb300y/') },
      credit: 'ESO',
      license: 'CC BY 4.0',
      sourceUrl: link,
      discovery: true,
    }];
  });
}

// ---------- Wikimedia Commons: "Media of the day" videos ----------
async function fromCommons() {
  const c = cfg.commons, api = 'https://commons.wikimedia.org/w/api.php';
  const titles = new Set();
  for (const query of c.queries) {
    const q = new URLSearchParams({
      action: 'query', format: 'json', list: 'search', srnamespace: '6', srlimit: String(c.perQuery),
      srsearch: `filetype:video incategory:"${c.category}" ${query}`,
    });
    try {
      const r = await getJSON(`${api}?${q}`, { delay: 200 });
      for (const s of r.query.search) titles.add(s.title);
    } catch (e) { console.warn('Commons search', query, e.message); }
  }
  const all = [...titles], out = [];
  for (let i = 0; i < all.length; i += 20) {
    const q = new URLSearchParams({
      action: 'query', format: 'json', titles: all.slice(i, i + 20).join('|'),
      prop: 'videoinfo', viprop: 'url|derivatives|extmetadata|mime|size', viurlwidth: '960',
      viextmetadatafilter: 'LicenseShortName|Artist|ImageDescription|ObjectName|Categories',
    });
    let r;
    try { r = await getJSON(`${api}?${q}`, { delay: 200 }); } catch (e) { console.warn('Commons info', e.message); continue; }
    for (const p of Object.values(r.query.pages)) {
      const vi = p.videoinfo?.[0];
      if (!vi || !vi.duration || vi.duration > c.maxDurationSeconds) continue;
      const m = vi.extmetadata || {};
      const name = cleanTitle(stripHtml(m.ObjectName?.value) || p.title.replace(/^File:/, '').replace(/\.[^.]+$/, ''));
      const desc = stripHtml(m.ImageDescription?.value).replace(/^Original caption:\s*/i, '').replace(/^"(.*)"$/, '$1');
      if (!isCalm(name, desc)) continue;
      if (!isNature(name, desc, stripHtml(m.Categories?.value).replace(/\|/g, ' '))) continue;
      // Prefer small transcodes; order mp4 first (Safari/iOS), then VP9 WebM, then original.
      const ders = (vi.derivatives || []).filter(d => d.width && d.width <= 1280);
      const pick = re => ders.filter(d => re.test(d.type)).sort((a, b) => b.width - a.width)[0];
      const sources = [pick(/mp4|quicktime/), pick(/vp9/), pick(/vp8/)].filter(Boolean)
        .map(d => ({ src: d.src.replace(/\?.*$/, ''), type: d.type.replace('video/quicktime', 'video/mp4') }));
      if (!sources.length) continue;
      out.push({
        id: `commons-${p.pageid}`,
        source: 'Wikimedia Commons',
        kind: 'video',
        topic: 'Motion',
        title: name,
        subtitle: '',
        caption: desc && desc !== name ? snippet(desc) : '',
        media: { sources, poster: (vi.thumburl || '').replace(/\?.*$/, ''), duration: Math.round(vi.duration) },
        credit: cleanCredit(m.Artist?.value) || 'Wikimedia Commons contributor',
        license: stripHtml(m.LicenseShortName?.value),
        sourceUrl: vi.descriptionurl,
      });
    }
  }
  return out;
}

// ---------- assemble ----------
const curated = JSON.parse(await readFile(path.join(root, 'curated.json'), 'utf8')).items || [];
let previous = { items: [] };
try { previous = JSON.parse(await readFile(path.join(root, 'feed.json'), 'utf8')); } catch {}

const runners = { inaturalist: fromINaturalist, nasa: fromNASA, nasaVideo: fromNASAVideo, eso: fromESO, commons: fromCommons };
const bySource = {};
for (const [name, fn] of Object.entries(runners)) {
  if (!want(name)) continue;
  const items = await fn();
  console.log(`${name}: ${items.length}`);
  bySource[name] = items;
}
// Sources not rebuilt this run (or that came back empty) keep their previous items.
// Items are matched to their runner by id prefix (NASA stills and videos share a source name).
const prefixOf = { inaturalist: 'inat-', nasa: 'nasa-', nasaVideo: 'nasavid-', eso: 'eso-', commons: 'commons-' };
for (const name of Object.keys(runners)) {
  if (!bySource[name]?.length) {
    bySource[name] = previous.items.filter(i => i.id.startsWith(prefixOf[name]) && !i.curated);
    if (want(name)) console.warn(`${name}: nothing fetched, keeping ${bySource[name].length} previous items`);
  }
}

const items = [...curated.map(i => ({ ...i, curated: true })), ...Object.values(bySource).flat()];
const ids = new Set(cfg.exclude?.ids || []);
const unique = items.filter(i => !ids.has(i.id) && ids.add(i.id));
await writeFile(path.join(root, 'feed.json'), JSON.stringify({ generated: new Date().toISOString(), count: unique.length, items: unique }, null, 1) + '\n');
console.log(`feed.json: ${unique.length} items`);

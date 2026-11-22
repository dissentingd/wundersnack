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
// Retries rate limits (429), server errors and network failures with backoff, so one bad response
// doesn't silently drop a whole group of items.
async function getJSON(url, { delay = 0, tries = 3 } = {}) {
  if (delay) await sleep(delay);
  for (let attempt = 1; ; attempt++) {
    let res;
    try { res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } }); }
    catch (e) { if (attempt >= tries) throw e; await sleep(5000 * attempt); continue; }
    if (res.ok) return res.json();
    if (attempt >= tries || !(res.status === 429 || res.status >= 500)) throw new Error(`${res.status} ${url}`);
    const wait = Number(res.headers.get('retry-after')) * 1000 || 10000 * attempt;
    console.warn(`  ${res.status}, retrying in ${Math.round(wait / 1000)}s`);
    await sleep(wait);
  }
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
// ---------- facts: pick the most wonder-worthy sentence from a Wikipedia lead ----------
// Leads usually open with taxonomy ("X is a species of fungus in the family Y") and range ("It is found in...").
// Those are dropped; the rest are scored for wonder (superlatives, glowing, mimicry, "can survive...", numbers)
// and against anatomy jargon and range/threat talk.
const TAXONOMY = [
  /\b(is|are|was) an? ([\w-]+ ){0,3}(species|genus|family|order|subfamily|subspecies|tribe|class|phylum|clade|group) of\b/i,
  /\b(described|circumscribed|transferred|reclassified|taxon|taxa|synonym|epithet|named (by|after|for|in honou?r)|classified|phylogen|holotype|monotypic|cladistic|etymolog)\w*/i,
  /\bfamily [A-Z]\w+(idae|aceae)\b/,
  /\b(in|of) the (genus|family|order|subfamily|tribe)\b/i,
  /\b(is|was) (native|endemic) to\b/i,
  /\b(Index Fungorum|species in the genus|includes \d+ species|contains \d+ species|derived from|Greek|Latin|classification|systematics?|molecular|genetic|DNA|genome|sequenc\w*|monophyl\w*|paraphyl\w*|stem-group|type species|only species in the genus|record of the family|fossil (genus|record))\b|†/i,
];
const WONDER = [
  [3, /\b(largest|smallest|biggest|tallest|longest|fastest|oldest|heaviest|deepest|brightest|loudest|strongest)\b/i],
  [2, /\b(only|unique|unusual|remarkabl|extraordinar|famous|notable|record|nicknamed|known as the|known for)\w*/i],
  [2, /\b(glow|biolumin|luminous|light|iridescen|transparent|translucent|fluoresc|colou?r|mimic|camouflag|disguis|symbio|mutualis|navigat|migrat|regenerat|surviv|withstand|dormant|ancient|fossil|evolv|evolution|intelligen|learn|communicat|sing|song|danc|courtship|cooperat|social|colon(y|ies)|farm|engineer|electric|magnet)\w*/i],
  [1, /\b(can|could|able to|capable|up to|as much as|more than|millions?|thousands?)\b/i],
  [1, /\d/],
];
const DULL = [
  [-3, /\b(found in|found throughout|can be found|occurs? in|distributed|distribution|range|recorded from|habitat|known from|inhabits?|its range)\b/i],
  [-2, /\b(cap|gills?|stipe|spores?|margin|setae|tergites?|sternites?|forewings?|hindwings?|antennae|thorax|abdomen|sporangi\w*|hyphae|basidi\w*|ascospores?|cheilocystidia|pileus|lamellae|carapace|mantle|rhinophores?|cerata)\b/i],
  [-1, /\b(endangered|threatened|declin\w*|extinct\w*|vulnerable|toxic|poison\w*|inedible)\b/i],
];
const tidy = t => t.replace(/\s*\((?:[^()]*\b(?:in|ft|mi|lb|oz|°F|yd)\b[^()]*)\)/g, '') // imperial conversions
  .replace(/\s*\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
function sentencesOf(text) {
  return tidy(stripHtml(text)).split(/(?<=[.!?])\s+(?=[A-Z"“(])/)
    .filter(x => x.length >= 40 && x.length <= 260 && /[.!?]$/.test(x) && isCalm(x));
}
// Candidate sentences, best first.
function rankFacts(text) {
  const out = [];
  for (const x of sentencesOf(text)) {
    if (TAXONOMY.some(re => re.test(x))) continue;
    let score = 0;
    for (const [w, re] of WONDER) if (re.test(x)) score += w;
    for (const [w, re] of DULL) if (re.test(x)) score += w;
    out.push({ text: x, score });
  }
  return out.sort((a, b) => b.score - a.score);
}
const wikiTitle = url => {
  const m = /\/wiki\/(.+)$/.exec(url || '');
  return m ? decodeURIComponent(m[1]).replace(/_/g, ' ') : null;
};
// Lead sections (plain text) for many titles; follows redirects; 20 titles per request (API limit for exintro).
async function wikiLeads(titles) {
  const out = new Map(), list = [...new Set(titles.filter(Boolean))];
  for (let i = 0; i < list.length; i += 20) {
    const batch = list.slice(i, i + 20);
    const q = new URLSearchParams({ action: 'query', format: 'json', prop: 'extracts', exintro: '1', explaintext: '1',
      exlimit: '20', redirects: '1', titles: batch.join('|') });
    try {
      const r = await getJSON(`https://en.wikipedia.org/w/api.php?${q}`, { delay: 200 });
      const alias = new Map();
      for (const n of [...(r.query.normalized || []), ...(r.query.redirects || [])]) alias.set(n.from, n.to);
      const byTitle = new Map(Object.values(r.query.pages || {}).map(p => [p.title, p.extract || '']));
      for (const t of batch) {
        let k = t;
        for (let hops = 0; alias.has(k) && hops < 3; hops++) k = alias.get(k);
        if (byTitle.get(k)) out.set(t, byTitle.get(k));
      }
    } catch (e) { console.warn('Wikipedia', e.message); }
  }
  return out;
}

// "(c) Jane Doe, some rights reserved (CC BY-NC)" -> "Jane Doe"
const cleanCredit = s => stripHtml(s).replace(/^\(c\)\s*/i, '')
  .replace(/,?\s*(some|no|all) rights reserved.*$/i, '').trim();
// "Hercostomus rogenhoferi - 2018-07-19" / "Nepenthes gracilis video2" -> tidy title
// "006 Dune 45 in Sossusvlei at sunrise Photo by Giles Laurent" -> "Dune 45 in Sossusvlei at sunrise"
const cleanTitle = s => s.replace(/_/g, ' ').replace(/\s*[-–]\s*\d{4}-\d{2}-\d{2}$/, '')
  .replace(/\s+(video\s*)?\d{1,2}$/i, '').replace(/^\d{4}-\d{2}-\d{2}\s+/, '')
  .replace(/\s+(photo|video|image|picture)\s+by\s+.+$/i, '').replace(/^\d{1,4}\s+/, '')
  .replace(/\s*\((cropped|edit\d*|crop)\)$/i, '').replace(/\s+(cropped|edit\d*|crop)$/i, '')
  // camera/date codes: "-- 2019 -- 3489", ", 2017-08-26, DD 130-132 PAN", " (1)", " nn", " 2015-3"
  .replace(/\s+--\s+\d{4}\b.*$/, '').replace(/,?\s+\d{4}-\d{2}-\d{2}\b.*$/, '').replace(/,?\s+DD\s+\d.*$/, '')
  .replace(/\s+\(\d+\)$/, '').replace(/\s+nn$/i, '').replace(/\s+\d{4}-\d{1,2}$/, '')
  // camera file names: "HDR-20200912-RM-155609", "IMG_1234", "DSC 0042", "P1010123"
  .replace(/[\s_-]+(HDR[-_])?\d{8}[-_][\w-]+$/i, '').replace(/[\s_-]+(IMG|DSC|DSCF|DSCN|P)[_ -]?\d{3,}$/i, '')
  .replace(/[\s,;-]+$/, '').trim();

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
      photo_license: c.photoLicenses.join(','), order_by: 'votes', per_page: String((taxon.perTaxon ?? c.perTaxon) * 2),
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
      if (seen.size >= (taxon.perTaxon ?? c.perTaxon)) break;
    }
  }
  // Facts: the species' Wikipedia lead, else its genus's, else its family's (via iNat's taxon links).
  const ids = [...new Set(out.map(x => x.o.taxon.id))];
  const taxa = new Map();
  for (let i = 0; i < ids.length; i += 30) {
    try {
      const r = await getJSON(`https://api.inaturalist.org/v1/taxa/${ids.slice(i, i + 30).join(',')}?locale=en`, { delay: 1100 });
      for (const t of r.results) taxa.set(t.id, t);
    } catch (e) { console.warn('iNat taxa', e.message); }
  }
  // Species first; then genus, family, order, phylum. Higher levels need a stronger sentence and rotate through
  // their good sentences, so neighbouring cards from the same group don't repeat one fact.
  const levels = t => {
    const anc = rank => (t?.ancestors || []).filter(a => a.rank === rank).pop();
    const about = a => `About ${a.preferred_common_name ? a.preferred_common_name.toLowerCase() : `the ${a.rank} ${a.name}`}: `;
    return {
      species: wikiTitle(t?.wikipedia_url),
      higher: ['genus', 'family', 'order', 'phylum'].map(anc).filter(a => a && a.wikipedia_url)
        .map(a => ({ title: wikiTitle(a.wikipedia_url), prefix: about(a) })),
    };
  };
  const leads = await wikiLeads([...taxa.values()].flatMap(t => { const l = levels(t); return [l.species, ...l.higher.map(h => h.title)]; }));
  const ranked = new Map([...leads].map(([k, v]) => [k, rankFacts(v)]));
  const used = new Map(); // sentence -> times used
  const facts = new Map();
  let fromSpecies = 0, fromHigher = 0;
  for (const [id, t] of taxa) {
    const { species, higher } = levels(t);
    const own = ranked.get(species) || [];
    if (own[0]?.score >= 1) { facts.set(id, own[0].text); fromSpecies++; continue; }
    let picked = false;
    for (const h of higher) {
      // least-used good sentence from this lead; each sentence appears on at most 3 cards
      const good = (ranked.get(h.title) || []).filter(f => f.score >= 2 && (used.get(f.text) || 0) < 3)
        .sort((a, b) => (used.get(a.text) || 0) - (used.get(b.text) || 0));
      if (!good.length) continue;
      used.set(good[0].text, (used.get(good[0].text) || 0) + 1);
      facts.set(id, h.prefix + good[0].text);
      fromHigher++; picked = true; break;
    }
    if (!picked && own[0]?.score >= 0) { facts.set(id, own[0].text); fromSpecies++; } // a plain species fact beats a generic line
  }
  console.log(`iNat facts: ${fromSpecies} from the species, ${fromHigher} from genus/family/order/phylum, ${taxa.size - fromSpecies - fromHigher} generic`);
  return out.map(({ o, taxon }) => {
    const p = o.photos[0];
    const common = o.taxon.preferred_common_name;
    const fact = facts.get(o.taxon.id);
    return {
      id: `inat-${o.id}`,
      source: 'iNaturalist',
      kind: 'image',
      topic: taxon.label,
      ...(taxon.weight != null && taxon.weight !== 1 ? { weight: taxon.weight } : {}),
      title: common ? common[0].toUpperCase() + common.slice(1) : o.taxon.name,
      subtitle: common ? o.taxon.name : '',
      caption: fact ? snippet(fact, 260) : taxon.wonder,
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
      // ~small = 640x360 H.264, sharp enough on phones; ~mobile is only 320x180.
      const src = ['~small.mp4', '~preview.mp4', '~mobile.mp4', '~medium.mp4'].map(k => hrefs.find(h => h.endsWith(k))).find(Boolean);
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
  const topicOf = new Map(); // file title -> topic (first group that found it wins)
  const groups = [{ topic: 'Motion', queries: c.queries }, ...(c.groups || [])];
  for (const g of groups) for (const query of g.queries) {
    const q = new URLSearchParams({
      action: 'query', format: 'json', list: 'search', srnamespace: '6', srlimit: String(c.perQuery),
      srsearch: `filetype:video incategory:"${c.category}" ${query}`,
    });
    try {
      const r = await getJSON(`${api}?${q}`, { delay: 200 });
      for (const s of r.query.search) if (!topicOf.has(s.title) || topicOf.get(s.title) === 'Motion') topicOf.set(s.title, g.topic);
    } catch (e) { console.warn('Commons search', query, e.message); }
  }
  const all = [...topicOf.keys()], out = [];
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
        topic: topicOf.get(p.title) || 'Motion',
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

// ---------- Wikimedia Commons: Featured Pictures by topic (geology, waves, wind) ----------
async function fromCommonsPictures() {
  const c = cfg.commonsPictures, api = 'https://commons.wikimedia.org/w/api.php';
  if (!c) return [];
  const topicOf = new Map();
  for (const g of c.groups) for (const query of g.queries) {
    const q = new URLSearchParams({
      action: 'query', format: 'json', list: 'search', srnamespace: '6', srlimit: String(c.perQuery),
      srsearch: `filetype:bitmap incategory:"${c.category}" ${query}`,
    });
    try {
      const r = await getJSON(`${api}?${q}`, { delay: 200 });
      for (const s of r.query.search) if (!topicOf.has(s.title)) topicOf.set(s.title, g.topic);
    } catch (e) { console.warn('Commons pictures search', query, e.message); }
  }
  // Prize-winning collections (Wiki Loves Earth winners, Picture of the Year finalists).
  const natureOnly = new Set();
  for (const col of c.collections || []) {
    const q = new URLSearchParams({
      action: 'query', format: 'json', list: 'search', srnamespace: '6', srlimit: String(col.max || 30), srsearch: col.search,
      ...(col.random ? { srsort: 'random' } : {}),
    });
    try {
      const r = await getJSON(`${api}?${q}`, { delay: 200 });
      for (const s of r.query.search) {
        topicOf.set(s.title, col.topic); // a prize beats a plain topic tag
        if (col.natureOnly) natureOnly.add(s.title); else natureOnly.delete(s.title);
      }
    } catch (e) { console.warn('Commons collection', col.topic, e.message); }
  }
  const all = [...topicOf.keys()], out = [];
  for (let i = 0; i < all.length; i += 20) {
    const q = new URLSearchParams({
      action: 'query', format: 'json', titles: all.slice(i, i + 20).join('|'),
      prop: 'imageinfo', iiprop: 'url|extmetadata|size|mime', iiurlwidth: '1280', iiextmetadatalanguage: 'en',
      iiextmetadatafilter: 'LicenseShortName|Artist|ImageDescription|ObjectName|Categories',
    });
    let r;
    try { r = await getJSON(`${api}?${q}`, { delay: 200 }); } catch (e) { console.warn('Commons pictures info', e.message); continue; }
    for (const p of Object.values(r.query.pages)) {
      const ii = p.imageinfo?.[0];
      if (!ii?.thumburl || !/jpe?g|png/.test(ii.mime || '')) continue;
      const m = ii.extmetadata || {};
      const name = cleanTitle(stripHtml(m.ObjectName?.value) || p.title.replace(/^File:/, '').replace(/\.[^.]+$/, ''));
      const desc = stripHtml(m.ImageDescription?.value).replace(/^Original caption( released with image)?:\s*/i, '');
      const cats = stripHtml(m.Categories?.value).replace(/\|/g, ' ');
      if (!isCalm(name, desc, cats)) continue;
      if (natureOnly.has(p.title) && !isNature(name, desc, cats)) continue;
      const src = ii.thumburl.replace(/\?.*$/, '');
      out.push({
        id: `commonsimg-${p.pageid}`,
        source: 'Wikimedia Commons',
        kind: 'image',
        topic: topicOf.get(p.title),
        title: name,
        subtitle: '',
        caption: desc && desc.toLowerCase() !== name.toLowerCase() ? snippet(desc) : '',
        // 1280 for phones; 1920 for big screens when the original is that large (Wikimedia serves fixed widths)
        media: { src, ...(ii.width > 1600 ? { hi: src.replace(/\/1280px-/, '/1920px-') } : {}), thumb: src.replace(/\/1280px-/, '/330px-') },
        credit: cleanCredit(m.Artist?.value) || 'Wikimedia Commons contributor',
        license: stripHtml(m.LicenseShortName?.value),
        sourceUrl: ii.descriptionurl,
      });
    }
  }
  return out;
}

// ---------- assemble ----------
const curated = JSON.parse(await readFile(path.join(root, 'curated.json'), 'utf8')).items || [];
let previous = { items: [] };
try { previous = JSON.parse(await readFile(path.join(root, 'feed.json'), 'utf8')); } catch {}

const runners = { inaturalist: fromINaturalist, nasa: fromNASA, nasaVideo: fromNASAVideo, eso: fromESO, commons: fromCommons, commonsPictures: fromCommonsPictures };
const bySource = {};
for (const [name, fn] of Object.entries(runners)) {
  if (!want(name)) continue;
  const items = await fn();
  console.log(`${name}: ${items.length}`);
  bySource[name] = items;
}
// Sources not rebuilt this run (or that came back empty) keep their previous items.
// Items are matched to their runner by id prefix (NASA stills and videos share a source name).
const prefixOf = { inaturalist: 'inat-', nasa: 'nasa-', nasaVideo: 'nasavid-', eso: 'eso-', commons: 'commons-', commonsPictures: 'commonsimg-' };
for (const name of Object.keys(runners)) {
  if (!bySource[name]?.length) {
    bySource[name] = previous.items.filter(i => i.id.startsWith(prefixOf[name]) && !i.curated);
    if (want(name)) console.warn(`${name}: nothing fetched, keeping ${bySource[name].length} previous items`);
  }
}

const items = [...curated.map(i => ({ ...i, curated: true })), ...Object.values(bySource).flat()];
const ids = new Set(cfg.exclude?.ids || []);
let unique = items.filter(i => !ids.has(i.id) && ids.add(i.id));

// "Gross, but cool": flag creepy-crawlies (and whole taxa marked grossButCool) so the app can hide them by default.
const grossRe = (cfg.grossButCool?.patterns || []).map(w => new RegExp(`\\b${w}`, 'i'));
const grossTopics = new Set((cfg.inaturalist?.taxa || []).filter(t => t.grossButCool).map(t => t.label));
unique = unique.map(i => {
  const { gross: _g, ...rest } = i;
  // Species photos are judged by their names (a caption like "mimics a wasp" isn't gross); videos also by
  // caption, since their titles are often bare Latin names.
  const text = [i.title, i.subtitle, i.topic, i.kind === 'video' ? i.caption : ''].filter(Boolean).join(' ');
  const gross = (i.source === 'iNaturalist' && grossTopics.has(i.topic))
    || (!(cfg.grossButCool?.skipSources || []).includes(i.source) && grossRe.some(re => re.test(text)));
  return gross ? { ...rest, gross: true } : rest;
});
console.log(`gross-but-cool: ${unique.filter(i => i.gross).length} items flagged`);

// Anonymous "Helped?" totals: score every voted item, leave out the ones that consistently don't help.
const v = cfg.votes;
const totalsUrl = process.env.WS_TOTALS_URL || v?.totalsUrl; // env override for local testing
if (totalsUrl) {
  try {
    const totals = (await getJSON(totalsUrl)).items || {};
    let scored = 0, dropped = 0;
    unique = unique.flatMap(i => {
      const t = totals[i.id];
      const { score: _s, votes: _v, ...rest } = i;
      if (!t) return [rest];
      const n = t.up + t.down, score = Math.round(((t.up + 1) / (n + 2)) * 1000) / 1000;
      if (n >= v.minVotes && score < v.dropBelow && !i.curated) { dropped++; return []; }
      scored++;
      return [{ ...rest, score, votes: n }];
    });
    console.log(`votes: ${scored} items scored, ${dropped} dropped as unhelpful`);
  } catch (e) { console.warn(`votes: totals unavailable (${e.message}); feed built without them`); }
}

await writeFile(path.join(root, 'feed.json'), JSON.stringify({ generated: new Date().toISOString(), count: unique.length, items: unique }, null, 1) + '\n');
console.log(`feed.json: ${unique.length} items`);

#!/usr/bin/env node
// Local review tool for trivia.json and facts.json: approve or edit drafted lines, and pick footage for fact cards.
//   node scripts/review.mjs            then open http://127.0.0.1:8790
// Footage search covers NASA and Wikimedia Commons (no keys), plus Pexels, Pixabay (videos) and Pexafy
// (photos) when PEXELS_API_KEY / PIXABAY_API_KEY / PEXAFY_API_KEY are set (environment, or a gitignored .env file in the repo root). Keys are only used here, on
// your machine: a picked clip is saved into facts.json with its file URL, credit and license, so the feed build
// needs no keys. Listens on 127.0.0.1 only.
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8790);
const UA = 'wundersnack-review/0.1 (+https://wundersnack.com)';

// .env (KEY=VALUE lines) for the stock-footage keys; real environment variables win.
try {
  for (const line of (await readFile(path.join(root, '.env'), 'utf8')).split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}
const keys = { pexels: process.env.PEXELS_API_KEY, pixabay: process.env.PIXABAY_API_KEY, pexafy: process.env.PEXAFY_API_KEY };

const FILES = { trivia: 'trivia.json', facts: 'facts.json' };
const load = async name => { try { return JSON.parse(await readFile(path.join(root, FILES[name]), 'utf8')); } catch { return { items: [] }; } };

const stripHtml = s => String(s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
async function getJSON(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers } });
  if (!res.ok) throw new Error(`${res.status} ${url.replace(/key=[^&]+/, 'key=…')}`);
  return res.json();
}

// ---------- footage search: every candidate has the shape facts.json stores ----------
async function nasa(q, n) {
  const r = await getJSON(`https://images-api.nasa.gov/search?${new URLSearchParams({ q, media_type: 'video', page_size: String(n * 2) })}`);
  const out = [];
  for (const item of r.collection.items.slice(0, n * 2)) {
    if (out.length >= n) break;
    const d = item.data?.[0];
    try {
      const m = await getJSON(`https://images-api.nasa.gov/asset/${encodeURIComponent(d.nasa_id)}`);
      const hrefs = m.collection.items.map(x => x.href.replace(/^http:/, 'https:'));
      const src = ['~small.mp4', '~preview.mp4', '~mobile.mp4'].map(k => hrefs.find(h => h.endsWith(k))).find(Boolean);
      const poster = ['~medium.jpg', '~small.jpg', '~thumb.jpg'].map(k => hrefs.find(h => h.endsWith(k))).find(Boolean);
      if (!src) continue;
      const enc = u => u && encodeURI(decodeURI(u));
      out.push({ provider: 'NASA', id: d.nasa_id, title: stripHtml(d.title), sources: [{ src: enc(src), type: 'video/mp4' }],
        poster: enc(poster) || '', duration: 0, credit: stripHtml(d.secondary_creator || d.center || 'NASA'),
        license: 'Public domain (NASA)', sourceUrl: `https://images.nasa.gov/details/${encodeURIComponent(d.nasa_id)}` });
    } catch {}
  }
  return out;
}
async function commons(q, n) {
  const api = 'https://commons.wikimedia.org/w/api.php';
  const s = await getJSON(`${api}?${new URLSearchParams({ action: 'query', format: 'json', list: 'search', srnamespace: '6', srlimit: String(n * 2), srsearch: `filetype:video ${q}` })}`);
  const titles = s.query.search.map(x => x.title);
  if (!titles.length) return [];
  const r = await getJSON(`${api}?${new URLSearchParams({ action: 'query', format: 'json', titles: titles.join('|'), prop: 'videoinfo',
    viprop: 'url|derivatives|extmetadata', viurlwidth: '640', viextmetadatafilter: 'LicenseShortName|Artist|ObjectName' })}`);
  const out = [];
  for (const p of Object.values(r.query.pages)) {
    const vi = p.videoinfo?.[0];
    if (!vi || out.length >= n) continue;
    const ders = (vi.derivatives || []).filter(d => d.width && d.width <= 1280);
    const pick = re => ders.filter(d => re.test(d.type)).sort((a, b) => b.width - a.width)[0];
    const sources = [pick(/mp4|quicktime/), pick(/vp9/), pick(/vp8/)].filter(Boolean)
      .map(d => ({ src: d.src.replace(/\?.*$/, ''), type: d.type.replace('video/quicktime', 'video/mp4') }));
    if (!sources.length) continue;
    const m = vi.extmetadata || {};
    out.push({ provider: 'Wikimedia Commons', id: String(p.pageid), title: stripHtml(m.ObjectName?.value) || p.title.replace(/^File:/, ''),
      sources, poster: (vi.thumburl || '').replace(/\?.*$/, ''), duration: Math.round(vi.duration || 0),
      credit: stripHtml(m.Artist?.value) || 'Wikimedia Commons contributor', license: stripHtml(m.LicenseShortName?.value),
      sourceUrl: vi.descriptionurl });
  }
  return out;
}
async function pexels(q, n) {
  if (!keys.pexels) return [];
  const r = await getJSON(`https://api.pexels.com/videos/search?${new URLSearchParams({ query: q, per_page: String(n), size: 'medium' })}`, { Authorization: keys.pexels });
  return (r.videos || []).flatMap(v => {
    const f = (v.video_files || []).filter(x => x.file_type === 'video/mp4' && x.width && x.width <= 1280)
      .sort((a, b) => b.width - a.width)[0];
    if (!f) return [];
    return [{ provider: 'Pexels', id: String(v.id), title: v.url.split('/').filter(Boolean).pop().replace(/-\d+$/, '').replace(/-/g, ' '),
      sources: [{ src: f.link, type: 'video/mp4' }], poster: v.image || '', duration: v.duration || 0,
      credit: v.user?.name || 'Pexels contributor', license: 'Pexels License', sourceUrl: v.url }];
  });
}
async function pixabay(q, n) {
  if (!keys.pixabay) return [];
  const r = await getJSON(`https://pixabay.com/api/videos/?${new URLSearchParams({ key: keys.pixabay, q, per_page: String(Math.max(3, n * 3)), safesearch: 'true' })}`);
  // A feed about real nature never shows AI-generated footage: skip anything Pixabay tags that way.
  // Tags seen in the wild: "ai generated", "generated to...", "realistic". Better to skip a real clip than show a fake.
  return (r.hits || []).filter(h => !/\bai\b|generat|\bcgi\b|\brender/i.test(h.tags || '')).slice(0, n).flatMap(h => {
    const f = ['medium', 'small', 'large'].map(k => h.videos?.[k]).find(x => x?.url && x.width <= 1920);
    if (!f) return [];
    // Pixabay asks that files be served from our own storage, not hotlinked: cache-media copies it to R2 and the
    // card only appears once that copy exists.
    return [{ provider: 'Pixabay', id: String(h.id), title: h.tags || '', sources: [{ src: f.url, type: 'video/mp4' }],
      poster: f.thumbnail || '', duration: h.duration || 0, credit: h.user || 'Pixabay contributor',
      license: 'Pixabay Content License', sourceUrl: h.pageURL, requiresCache: true }];
  });
}
// Pexafy: one search over free photo libraries (Pexels, Unsplash, Pixabay, ...). Photos only; a fact card with a
// photo shows it dimmed behind the text, like footage. Credit and link go to the original library and photographer.
const PHOTO_LICENSES = { pexels: 'Pexels License', unsplash: 'Unsplash License', pixabay: 'Pixabay Content License' };
async function pexafy(q, n) {
  if (!keys.pexafy) return [];
  const r = await getJSON(`https://api.pexafy.com/api/v1/search/photos?${new URLSearchParams({ q, per_page: String(n), license_type: 'free' })}`, { 'x-api-key': keys.pexafy });
  return (r.data || []).flatMap(p => {
    const u = p.urls || {};
    const src = u.regular || u.large || p.image_url;
    if (!src) return [];
    const lib = String(p.source || 'Pexafy');
    return [{ kind: 'image', provider: lib, id: String(p.photo_id), title: p.alt_description || p.description || '',
      media: { src, ...(u.large && u.large !== src ? { hi: u.large } : {}), thumb: u.small || u.thumb || src },
      poster: u.small || u.thumb || src, credit: p.photographer_full_name || p.photographer_username || lib,
      license: PHOTO_LICENSES[lib.toLowerCase()] || `${lib} license`, sourceUrl: p.source_image_url || p.image_url,
      via: 'Pexafy', ...(lib.toLowerCase() === 'pixabay' ? { requiresCache: true } : {}) }];
  });
}
const PROVIDERS = { nasa, commons, pexels, pixabay, pexafy };

// ---------- page ----------
const PAGE = String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>wundersnack review</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
 body{font:15px/1.45 system-ui,sans-serif;margin:0;background:#111418;color:#eee}
 header{position:sticky;top:0;background:#1b1f25;padding:10px 16px;display:flex;gap:10px;align-items:center;z-index:5;border-bottom:1px solid #333}
 header h1{font-size:1rem;margin:0 12px 0 0} button,select,input,textarea{font:inherit}
 button{background:#2a3038;color:#eee;border:1px solid #444;border-radius:6px;padding:5px 10px;cursor:pointer}
 button.on,button.primary{background:#ffcf6b;color:#111;border-color:#ffcf6b}
 main{padding:16px;max-width:1100px;margin:auto} .row{border:1px solid #333;border-radius:10px;padding:12px;margin:0 0 12px;background:#171b20}
 .row.approved{border-color:#4caf50}.row.rejected{opacity:.5}
 .meta{color:#aaa;font-size:.85rem;margin-bottom:6px} textarea{width:100%;box-sizing:border-box;background:#0d1013;color:#eee;border:1px solid #444;border-radius:6px;padding:6px}
 input[type=text]{background:#0d1013;color:#eee;border:1px solid #444;border-radius:6px;padding:4px 6px}
 .line{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px} a{color:#9fd8ff}
 .cands{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px;margin-top:10px}
 .cand{background:#0d1013;border:1px solid #333;border-radius:8px;padding:6px;font-size:.8rem}.cand.picked{border-color:#ffcf6b}
 .cand video{width:100%;aspect-ratio:16/9;background:#000;border-radius:4px} .pick{color:#ffcf6b;font-size:.85rem}
 #status{margin-left:auto;color:#aaa;font-size:.85rem}
</style></head><body>
<header><h1>wundersnack review</h1><button data-tab="trivia" class="on">Trivia</button><button data-tab="facts">Fact cards</button>
<select id="filter"><option value="">All</option><option>draft</option><option>approved</option><option>rejected</option></select>
<button id="save" class="primary">Save</button><span id="status"></span></header>
<main id="main"></main>
<script type="module">
const el=(t,p={},...k)=>{const n=Object.assign(document.createElement(t),p);for(const c of k)if(c!=null)n.append(c);return n};
let data, tab='trivia', dirty=false;
const status=t=>document.getElementById('status').textContent=t;
const mark=()=>{dirty=true;status('Unsaved changes')};
const statusSel=(o,row)=>{const s=el('select');for(const v of ['draft','approved','rejected'])s.append(el('option',{value:v,textContent:v,selected:o.status===v}));
  s.onchange=()=>{if(tab==='facts'&&s.value==='approved'&&!o.footage){alert('Pick footage first.');s.value=o.status;return}o.status=s.value;row.className='row '+o.status;mark()};return s};
const field=(o,k,rows=2)=>{const t=el('textarea',{rows,value:o[k]||''});t.oninput=()=>{o[k]=t.value;mark()};return t};
const citeLine=o=>{const t=el('input',{type:'text',value:o.cite?.title||'',size:30}),u=el('input',{type:'text',value:o.cite?.url||'',size:60});
  const set=()=>{o.cite={title:t.value,url:u.value};mark()};t.oninput=set;u.oninput=set;
  return el('div',{className:'line'},'Source:',t,u,el('a',{href:o.cite?.url,target:'_blank',rel:'noopener',textContent:'open ↗'}))};
function render(){
  const main=document.getElementById('main');main.replaceChildren();const f=document.getElementById('filter').value;
  const list=data[tab].items.filter(o=>!f||o.status===f);
  if(tab==='trivia'){
    main.append(el('p',{className:'meta',textContent:'A line shows on cards it matches: taxon (iNaturalist species or genus) beats a title word, which beats a topic. Only approved lines go live on the next feed build.'}));
    for(const o of list){const row=el('div',{className:'row '+o.status});
      const m=Object.entries(o.match).map(([k,v])=>k+': '+v).join(', ');
      row.append(el('div',{className:'meta',textContent:o.id+'  ·  matches '+m+(o.note?'  ·  '+o.note:'')}),field(o,'text'),citeLine(o),el('div',{className:'line'},'Status:',statusSel(o,row)));main.append(row)}
  } else {
    main.append(el('p',{className:'meta',textContent:'Footage: NASA and Commons always; Pexels '+(data.keys.pexels?'on':'off (no PEXELS_API_KEY)')+'; Pixabay '+(data.keys.pixabay?'on':'off (no PIXABAY_API_KEY)')+'; Pexafy photos '+(data.keys.pexafy?'on':'off (no PEXAFY_API_KEY)')+'. Pick a calm clip or photo that suits the fact; it shows muted and dimmed behind the text.'}));
    for(const o of list){const row=el('div',{className:'row '+o.status});
      const title=el('input',{type:'text',value:o.title,size:50});title.oninput=()=>{o.title=title.value;mark()};
      const q=el('input',{type:'text',value:o.query||'',size:40});q.oninput=()=>{o.query=q.value;mark()};
      const cands=el('div',{className:'cands'});
      const pickInfo=el('div',{className:'pick'});
      const showPick=()=>pickInfo.textContent=o.footage?'Picked: '+o.footage.provider+' · '+o.footage.title+' · '+o.footage.credit+' · '+o.footage.license:'No footage picked yet';
      showPick();
      const find=el('button',{textContent:'Find footage'});
      find.onclick=async()=>{cands.replaceChildren(el('span',{textContent:'Searching…'}));
        const r=await fetch('/api/footage?q='+encodeURIComponent(q.value)).then(r=>r.json());cands.replaceChildren();
        for(const e of r.errors||[])cands.append(el('div',{className:'meta',textContent:e}));
        for(const c of r.items){let v;
          if(c.kind==='image')v=el('img',{src:c.media.thumb,alt:c.title,loading:'lazy',style:'width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:4px'});
          else{v=el('video',{muted:true,loop:true,controls:true,preload:'none',poster:c.poster||''});
          for(const s of c.sources)v.append(el('source',{src:s.src,type:s.type.split(';')[0]}));
          v.onmouseenter=()=>v.play().catch(()=>{});v.onmouseleave=()=>v.pause();}
          const use=el('button',{textContent:'Use this'});
          const box=el('div',{className:'cand'+(o.footage&&o.footage.provider===c.provider&&o.footage.id===c.id?' picked':'')},v,
            el('div',{textContent:(c.kind==='image'?'Photo · ':'')+c.provider+(c.via?' (via '+c.via+')':'')+(c.duration?' · '+c.duration+'s':'')+' · '+c.title}),
            el('div',{className:'meta'},c.credit+' · '+c.license+' · ',el('a',{href:c.sourceUrl,target:'_blank',rel:'noopener',textContent:'page ↗'})),use);
          use.onclick=()=>{o.footage=c;mark();showPick();cands.querySelectorAll('.cand').forEach(x=>x.classList.remove('picked'));box.classList.add('picked')};
          cands.append(box)}
        if(!r.items.length)cands.append(el('span',{textContent:'Nothing found; try other words.'}))};
      row.append(el('div',{className:'meta',textContent:o.id+'  ·  '+o.topic+(o.note?'  ·  '+o.note:'')}),el('div',{className:'line'},'Headline:',title),field(o,'text',3),citeLine(o),
        el('div',{className:'line'},'Footage search:',q,find),pickInfo,cands,el('div',{className:'line'},'Status:',statusSel(o,row)));main.append(row)}
  }
}
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{tab=b.dataset.tab;document.querySelectorAll('[data-tab]').forEach(x=>x.classList.toggle('on',x===b));render()});
document.getElementById('filter').onchange=render;
document.getElementById('save').onclick=async()=>{for(const name of ['trivia','facts']){
  const r=await fetch('/api/save?file='+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data[name])});
  if(!r.ok){status('Save failed: '+await r.text());return}}dirty=false;status('Saved '+new Date().toLocaleTimeString())};
addEventListener('beforeunload',e=>{if(dirty)e.preventDefault()});
data=await fetch('/api/data').then(r=>r.json());render();
</script></body></html>`;

// ---------- server ----------
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, PAGE, 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/data')
      return send(res, 200, { trivia: await load('trivia'), facts: await load('facts'), keys: { pexels: !!keys.pexels, pixabay: !!keys.pixabay, pexafy: !!keys.pexafy } });
    if (req.method === 'GET' && url.pathname === '/api/footage') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return send(res, 400, { items: [], errors: ['Type some search words first.'] });
      const results = await Promise.allSettled(Object.entries(PROVIDERS).map(([, fn]) => fn(q, 4)));
      const items = [], errors = [];
      results.forEach((r, i) => r.status === 'fulfilled' ? items.push(...r.value) : errors.push(`${Object.keys(PROVIDERS)[i]}: ${r.reason.message}`));
      return send(res, 200, { items, errors });
    }
    if (req.method === 'POST' && url.pathname === '/api/save') {
      const name = url.searchParams.get('file');
      if (!FILES[name]) return send(res, 400, 'unknown file', 'text/plain');
      // Same-origin only: a page on another site must not be able to write these files.
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(res, 403, 'forbidden', 'text/plain');
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      if (!Array.isArray(parsed.items)) return send(res, 400, 'items missing', 'text/plain');
      await writeFile(path.join(root, FILES[name]), JSON.stringify(parsed, null, 1) + '\n');
      return send(res, 200, { ok: true });
    }
    send(res, 404, 'not found', 'text/plain');
  } catch (e) { send(res, 500, e.message, 'text/plain'); }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`wundersnack review: http://127.0.0.1:${PORT}`);
  console.log(`Pexels ${keys.pexels ? 'on' : 'off (set PEXELS_API_KEY)'}, Pixabay ${keys.pixabay ? 'on' : 'off (set PIXABAY_API_KEY)'}, Pexafy ${keys.pexafy ? 'on' : 'off (set PEXAFY_API_KEY)'}`);
});

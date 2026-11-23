#!/usr/bin/env node
// Keeps our own H.264 copies of Wikimedia Commons videos in Cloudflare R2 and points feed.json at them.
//
// Why: Commons only offers MPEG-4 Part 2 (.mov) and WebM transcodes, which iPhone Safari plays unreliably,
// and Commons rate-limits heavy hotlinking. Each Commons video is converted once (ffmpeg, H.264 + AAC,
// max 1280 px wide, 30 fps, faststart) and served from mediaCache.baseUrl. The original Commons sources stay
// listed after ours as an automatic fallback, and every card keeps its creator, license and source link.
//
// Modes:
//   node scripts/cache-media.mjs                 attach copies listed in the public manifest (no credentials needed)
//   node scripts/cache-media.mjs --upload        also convert + upload up to --limit new videos (needs R2 credentials
//                                                and the AWS CLI; see README), then update the manifest
//   node scripts/cache-media.mjs --dry-run=DIR   convert up to --limit videos into DIR without uploading (for testing)
//   --limit=N                                    max new videos per run (default 60)
import { readFile, writeFile, mkdtemp, rm, stat, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(await readFile(path.join(root, 'sources.config.json'), 'utf8')).mediaCache;
const arg = name => process.argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
const val = name => arg(name)?.split('=').slice(1).join('=');
const UPLOAD = !!arg('upload');
const DRY = val('dry-run');
const LIMIT = Number(val('limit') || 60);
const LIMIT_IMAGES = Number(val('limit-images') || 200); // photos are a plain copy, so cheap
const UA = 'wundersnack-media-cache/0.1 (+https://wundersnack.com)';
const base = cfg.baseUrl.replace(/\/$/, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const keyFor = id => id.replace(/[^\w.-]+/g, '_');
const videoKey = id => `v/${keyFor(id)}.mp4`;
const posterKey = id => `p/${keyFor(id)}.jpg`;
const imageKey = (id, hi) => `i/${keyFor(id)}${hi ? '-hi' : ''}.jpg`;
const CACHED_TYPE = 'video/mp4; codecs="avc1.4D401F, mp4a.40.2"'; // H.264 Main@3.1 + AAC-LC

// ---------- manifest: { "<item id>": { "v": "v/<key>.mp4", "p": "p/<key>.jpg", "at": "..." } } ----------
async function loadManifest() {
  if (UPLOAD) {
    // Read it straight from the bucket: the authoritative copy, and independent of the public domain.
    // Anything other than "doesn't exist yet" aborts, so a hiccup can never reset (and overwrite) the manifest.
    try {
      const { stdout } = await run('aws', ['s3', 'cp', `s3://${cfg.bucket}/manifest.json`, '-',
        '--endpoint-url', `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`], { env: awsEnv(), maxBuffer: 1 << 26 });
      return JSON.parse(stdout);
    } catch (e) {
      if (/NoSuchKey|Not Found|404/.test(`${e.stderr || ''}${e.message}`)) { console.warn('manifest: not in bucket yet, starting empty'); return {}; }
      throw new Error(`could not read manifest from the bucket: ${(e.stderr || e.message).trim()}`);
    }
  }
  try {
    const res = await fetch(`${base}/manifest.json`, { headers: { 'User-Agent': UA }, cache: 'no-store' });
    if (res.ok) return await res.json();
    console.warn(`manifest: ${res.status}, starting empty`);
  } catch (e) { console.warn(`manifest: ${e.message}, starting empty`); }
  return {};
}

// ---------- R2 via the AWS CLI (S3-compatible API) ----------
function awsEnv() {
  const need = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
  const missing = need.filter(k => !process.env[k]);
  if (missing.length) throw new Error(`--upload needs ${missing.join(', ')}`);
  return {
    ...process.env,
    AWS_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    AWS_DEFAULT_REGION: 'auto',
    AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required',
    AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required',
  };
}
async function putObject(file, key, contentType, cacheControl) {
  const endpoint = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  await run('aws', ['s3', 'cp', file, `s3://${cfg.bucket}/${key}`, '--endpoint-url', endpoint,
    '--content-type', contentType, '--cache-control', cacheControl, '--only-show-errors'], { env: awsEnv() });
}

const endpointUrl = () => `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
// Every object in the bucket with its size (the CLI follows pagination itself).
async function listBucket() {
  const { stdout } = await run('aws', ['s3api', 'list-objects-v2', '--bucket', cfg.bucket, '--endpoint-url', endpointUrl(),
    '--query', 'Contents[].[Key,Size]', '--output', 'json'], { env: awsEnv(), maxBuffer: 1 << 26 });
  return new Map((JSON.parse(stdout || 'null') || []).map(([k, s]) => [k, Number(s)]));
}
async function deleteObject(key) {
  await run('aws', ['s3', 'rm', `s3://${cfg.bucket}/${key}`, '--endpoint-url', endpointUrl(), '--only-show-errors'], { env: awsEnv() });
}

// ---------- storage budget ----------
// Keeps the bucket under mediaCache.maxBytes (R2's free tier is 10 GB). Copies of items that left the feed are
// pruned; when a new file wouldn't fit, the worst-voted cached items (helped < 50%) are deleted first; if there's
// still no room, new items are skipped and keep loading from Wikimedia.
const MAX_BYTES = Number(cfg.maxBytes || 9e9);
const budget = { used: 0, sizes: new Map(), pruned: 0, evicted: 0, skipped: 0 };
const keysOf = e => [e.v, e.p, e.i, e.h].filter(Boolean);
async function dropEntry(id) {
  for (const k of keysOf(manifest[id])) {
    await deleteObject(k);
    budget.used -= budget.sizes.get(k) || 0;
    budget.sizes.delete(k);
  }
  delete manifest[id];
}
async function pruneAndMeasure(feedIds, scoreOf) {
  budget.sizes = await listBucket();
  const ids = Object.keys(manifest);
  const gone = ids.filter(id => !feedIds.has(id)); // left the feed (e.g. voted out)
  // Safety: a half-built feed must never wipe the cache. Big prunes are skipped with a warning.
  if (gone.length > 20 && gone.length > ids.length / 4) {
    console.warn(`storage: ${gone.length} of ${ids.length} cached items are missing from feed.json; not pruning this run`);
  } else {
    for (const id of gone) { await dropEntry(id); budget.pruned++; }
  }
  const referenced = new Set(['manifest.json']);
  for (const id of Object.keys(manifest)) keysOf(manifest[id]).forEach(k => referenced.add(k));
  const strays = [...budget.sizes.keys()].filter(k => !referenced.has(k));
  if (ids.length && strays.length <= Math.max(20, budget.sizes.size / 4)) {
    for (const k of strays) { await deleteObject(k); budget.sizes.delete(k); }
  } else if (strays.length) console.warn(`storage: ${strays.length} unlisted files left alone (manifest empty or too many to be strays)`);
  budget.used = [...budget.sizes.values()].reduce((a, b) => a + b, 0);
  budget.scoreOf = scoreOf;
  console.log(`storage: ${(budget.used / 1e6).toFixed(0)} MB of ${(MAX_BYTES / 1e6).toFixed(0)} MB; pruned ${budget.pruned} items no longer in the feed`);
}
// Make room for `bytes` more; returns false if it can't be done without evicting well-liked items.
async function makeRoom(bytes) {
  if (budget.used + bytes <= MAX_BYTES) return true;
  const evictable = Object.keys(manifest).filter(id => (budget.scoreOf(id) ?? 0.5) < 0.5)
    .sort((a, b) => budget.scoreOf(a) - budget.scoreOf(b));
  for (const id of evictable) {
    if (budget.used + bytes <= MAX_BYTES) break;
    await dropEntry(id); budget.evicted++;
  }
  if (budget.used + bytes <= MAX_BYTES) return true;
  budget.skipped++;
  return false;
}

// ---------- convert ----------
async function download(url, file) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.ok && !(res.headers.get('content-type') || '').includes('text/html')) {
      await writeFile(file, Buffer.from(await res.arrayBuffer()));
      return;
    }
    console.warn(`  download ${res.status} (attempt ${attempt}), waiting`);
    await sleep(15000 * attempt);
  }
  throw new Error(`could not download ${url}`);
}
async function convert(input, outVideo, outPoster) {
  await run('ffmpeg', ['-y', '-v', 'error', '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', "scale='min(1280,iw)':-2:flags=lanczos,format=yuv420p", '-fpsmax', '30',
    '-c:v', 'libx264', '-profile:v', 'main', '-level', '3.1', '-preset', 'veryfast', '-crf', '26',
    '-c:a', 'aac', '-b:a', '96k', '-ac', '2', '-movflags', '+faststart', outVideo], { maxBuffer: 1 << 24 });
  await run('ffmpeg', ['-y', '-v', 'error', '-ss', '1', '-i', outVideo, '-frames:v', '1',
    '-vf', "scale='min(960,iw)':-2", '-q:v', '4', outPoster]);
}
// Best input: the largest WebM/VP9 transcode (good quality, small), else whatever Commons offers.
const inputFor = it => {
  const s = it.media.sources.filter(x => !x.cached);
  return (s.find(x => /vp9/.test(x.type)) || s.find(x => /webm/.test(x.type)) || s[0])?.src;
};

// ---------- main ----------
const feedPath = path.join(root, 'feed.json');
const feed = JSON.parse(await readFile(feedPath, 'utf8'));
const manifest = await loadManifest();
// Commons videos, plus fact-card footage that isn't NASA's (NASA already serves phone-friendly H.264).
const videos = feed.items.filter(i => i.kind === 'video' && (i.id.startsWith('commons-') || (i.id.startsWith('fact-') && i.source !== 'NASA')));
// Commons photos, plus fact-card photos whose library asks not to be hotlinked (Pixabay, found via Pexafy).
const pictures = feed.items.filter(i => i.kind === 'image' && (i.id.startsWith('commonsimg-') || (i.id.startsWith('fact-') && i.media.requiresCache)));
const todo = videos.filter(i => !manifest[i.id]).slice(0, LIMIT);

if (UPLOAD || DRY) {
  if (UPLOAD) {
    awsEnv(); // fail fast if credentials are missing
    const scores = new Map(feed.items.filter(i => typeof i.score === 'number').map(i => [i.id, i.score]));
    await pruneAndMeasure(new Set(feed.items.map(i => i.id)), id => scores.get(id));
  }
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'ws-media-'));
  if (DRY) await mkdir(DRY, { recursive: true });
  let done = 0;
  for (const it of todo) {
    const src = inputFor(it);
    if (!src) continue;
    const k = keyFor(it.id);
    const input = path.join(tmp, `${k}.in`);
    const outV = path.join(DRY || tmp, `${k}.mp4`), outP = path.join(DRY || tmp, `${k}.jpg`);
    try {
      console.log(`[${++done}/${todo.length}] ${it.id}  ${it.title}`);
      await download(src, input);
      await convert(input, outV, outP);
      const mb = ((await stat(outV)).size / 1048576).toFixed(1);
      if (UPLOAD) {
        const sv = (await stat(outV)).size, sp = (await stat(outP)).size;
        if (!(await makeRoom(sv + sp))) { console.log('  storage budget full: skipped (stays on Wikimedia)'); continue; }
        await putObject(outV, videoKey(it.id), 'video/mp4', 'public, max-age=31536000, immutable');
        await putObject(outP, posterKey(it.id), 'image/jpeg', 'public, max-age=31536000, immutable');
        manifest[it.id] = { v: videoKey(it.id), p: posterKey(it.id), at: new Date().toISOString() };
        budget.sizes.set(videoKey(it.id), sv); budget.sizes.set(posterKey(it.id), sp); budget.used += sv + sp;
      }
      console.log(`  ok, ${mb} MB`);
    } catch (e) {
      console.warn(`  skipped: ${e.message.split('\n')[0]}`);
    } finally {
      await rm(input, { force: true });
      if (!DRY) { await rm(outV, { force: true }); await rm(outP, { force: true }); }
    }
    await sleep(2000); // be gentle with upload.wikimedia.org
  }
  // Commons photos: copy Wikimedia's 1280 px (and 1920 px) JPEG thumbnails as-is.
  const imgTodo = pictures.filter(i => !manifest[i.id]).slice(0, LIMIT_IMAGES);
  let n = 0;
  for (const it of imgTodo) {
    const k = keyFor(it.id);
    const src = it.media.originalSrc || it.media.src, hi = it.media.originalHi ?? it.media.hi;
    const out = path.join(DRY || tmp, `${k}.jpg`), outHi = path.join(DRY || tmp, `${k}-hi.jpg`);
    try {
      console.log(`[photo ${++n}/${imgTodo.length}] ${it.id}  ${it.title}`);
      await download(src, out);
      if (hi) await download(hi, outHi);
      if (UPLOAD) {
        const s1 = (await stat(out)).size, s2 = hi ? (await stat(outHi)).size : 0;
        if (!(await makeRoom(s1 + s2))) { console.log('  storage budget full: skipped (stays on Wikimedia)'); continue; }
        await putObject(out, imageKey(it.id), 'image/jpeg', 'public, max-age=31536000, immutable');
        if (hi) await putObject(outHi, imageKey(it.id, true), 'image/jpeg', 'public, max-age=31536000, immutable');
        manifest[it.id] = { i: imageKey(it.id), ...(hi ? { h: imageKey(it.id, true) } : {}), at: new Date().toISOString() };
        budget.sizes.set(imageKey(it.id), s1); if (hi) budget.sizes.set(imageKey(it.id, true), s2); budget.used += s1 + s2;
      }
    } catch (e) {
      console.warn(`  skipped: ${e.message.split('\n')[0]}`);
    } finally {
      if (!DRY) { await rm(out, { force: true }); await rm(outHi, { force: true }); }
    }
    await sleep(1000);
  }
  await rm(tmp, { recursive: true, force: true });
  if (UPLOAD) {
    const mf = path.join(os.tmpdir(), `ws-manifest-${process.pid}.json`);
    await writeFile(mf, JSON.stringify(manifest, null, 1));
    await putObject(mf, 'manifest.json', 'application/json', 'no-cache');
    console.log(`storage: ${(budget.used / 1e6).toFixed(0)} MB used after this run; evicted ${budget.evicted} low-rated, skipped ${budget.skipped} for lack of room`);
    await rm(mf, { force: true });
  }
}

// Attach cached copies (ours first, originals kept as fallback). Footage whose source asks to be served from our
// own storage (Pixabay) only appears once it has been cached.
let attached = 0, held = 0;
for (const it of videos) {
  const m = manifest[it.id];
  const originals = it.media.sources.filter(s => !s.cached);
  if (!m) { it.media.sources = originals; if (it.media.requiresCache) { it.held = true; held++; } continue; }
  it.media.sources = [{ src: `${base}/${m.v}`, type: CACHED_TYPE, cached: true }, ...originals];
  if (m.p) { it.media.originalPoster ??= it.media.poster; it.media.poster = `${base}/${m.p}`; }
  attached++;
}
let attachedImg = 0;
for (const it of pictures) {
  const m = manifest[it.id];
  const origSrc = it.media.originalSrc || it.media.src, origHi = it.media.originalHi ?? it.media.hi;
  delete it.media.originalSrc; delete it.media.originalHi; delete it.media.fallback;
  if (!m?.i) {
    it.media.src = origSrc; if (origHi) it.media.hi = origHi; else delete it.media.hi;
    if (it.media.requiresCache) { it.held = true; held++; }
    continue;
  }
  it.media.originalSrc = origSrc;
  if (origHi) it.media.originalHi = origHi;
  it.media.src = `${base}/${m.i}`;
  if (m.h) it.media.hi = `${base}/${m.h}`; else delete it.media.hi;
  it.media.fallback = origSrc; // the app switches to Wikimedia's copy if ours fails to load
  attachedImg++;
}
if (held) {
  feed.items = feed.items.filter(i => !i.held);
  feed.count = feed.items.length;
  console.log(`media cache: ${held} fact cards held back until their footage is cached`);
}
await writeFile(feedPath, JSON.stringify(feed, null, 1) + '\n');
console.log(`media cache: ${attachedImg}/${pictures.length} Commons photos served from ${base}`);
console.log(`media cache: ${attached}/${videos.length} Commons/fact videos served from ${base}` +
  (UPLOAD ? `, ${Object.keys(manifest).length} in manifest` : '') + (DRY ? ` (dry run: files in ${DRY})` : ''));

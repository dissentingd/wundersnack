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
const UA = 'wundersnack-media-cache/0.1 (+https://wundersnack.com)';
const base = cfg.baseUrl.replace(/\/$/, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const keyFor = id => id.replace(/[^\w.-]+/g, '_');
const videoKey = id => `v/${keyFor(id)}.mp4`;
const posterKey = id => `p/${keyFor(id)}.jpg`;
const CACHED_TYPE = 'video/mp4; codecs="avc1.4D401F, mp4a.40.2"'; // H.264 Main@3.1 + AAC-LC

// ---------- manifest: { "<item id>": { "v": "v/<key>.mp4", "p": "p/<key>.jpg", "at": "..." } } ----------
async function loadManifest() {
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
const videos = feed.items.filter(i => i.kind === 'video' && i.id.startsWith('commons-'));
const todo = videos.filter(i => !manifest[i.id]).slice(0, LIMIT);

if (UPLOAD || DRY) {
  if (UPLOAD) awsEnv(); // fail fast if credentials are missing
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
        await putObject(outV, videoKey(it.id), 'video/mp4', 'public, max-age=31536000, immutable');
        await putObject(outP, posterKey(it.id), 'image/jpeg', 'public, max-age=31536000, immutable');
        manifest[it.id] = { v: videoKey(it.id), p: posterKey(it.id), at: new Date().toISOString() };
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
  await rm(tmp, { recursive: true, force: true });
  if (UPLOAD) {
    const mf = path.join(os.tmpdir(), `ws-manifest-${process.pid}.json`);
    await writeFile(mf, JSON.stringify(manifest, null, 1));
    await putObject(mf, 'manifest.json', 'application/json', 'no-cache');
    await rm(mf, { force: true });
  }
}

// Attach cached copies (ours first, Commons originals kept as fallback).
let attached = 0;
for (const it of videos) {
  const m = manifest[it.id];
  const originals = it.media.sources.filter(s => !s.cached);
  if (!m) { it.media.sources = originals; continue; }
  it.media.sources = [{ src: `${base}/${m.v}`, type: CACHED_TYPE, cached: true }, ...originals];
  if (m.p) { it.media.originalPoster ??= it.media.poster; it.media.poster = `${base}/${m.p}`; }
  attached++;
}
await writeFile(feedPath, JSON.stringify(feed, null, 1) + '\n');
console.log(`media cache: ${attached}/${videos.length} Commons videos served from ${base}` +
  (UPLOAD ? `, ${Object.keys(manifest).length} in manifest` : '') + (DRY ? ` (dry run: files in ${DRY})` : ''));

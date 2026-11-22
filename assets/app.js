// wundersnack feed: vertical, full-screen, swipeable. No framework, no tracking.
const feedEl = document.getElementById('feed');
const soundBtn = document.getElementById('sound');
const BATCH = 8;

let items = [];
let cursor = 0;
let soundOn = false;
let active = null;

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- this device's memory (localStorage only; never sent anywhere) ----------
const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
};
const myVotes = store.get('ws.votes', {});   // { itemId: 1 | -1 }
const seen = store.get('ws.seen', {});       // { itemId: lastSeenMs }
const SEEN_MAX = 4000;
function markSeen(id) {
  seen[id] = Date.now();
  const ids = Object.keys(seen);
  if (ids.length > SEEN_MAX) ids.sort((a, b) => seen[a] - seen[b]).slice(0, ids.length - SEEN_MAX).forEach(k => delete seen[k]);
  store.set('ws.seen', seen);
}

// ---------- ordering ----------
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// This device's taste, learned from its own votes: per topic, source and kind.
function tasteModel(all) {
  const byId = new Map(all.map(i => [i.id, i]));
  const t = new Map();
  const add = (k, v) => t.set(k, (t.get(k) || 0) + v);
  for (const [id, v] of Object.entries(myVotes)) {
    const it = byId.get(id);
    if (!it) continue;
    add(`topic:${it.topic}`, v); add(`source:${it.source}`, v * 0.5); add(`kind:${it.kind}`, v * 0.5);
  }
  return it => Math.tanh(((t.get(`topic:${it.topic}`) || 0) + (t.get(`source:${it.source}`) || 0) + (t.get(`kind:${it.kind}`) || 0)) / 3);
}
// Higher = sooner. Unseen first; among those, everyone's votes (feed score) + this device's taste + randomness,
// so repeat visitors keep meeting new things and nobody gets the same "top" list.
function ranker(all) {
  const taste = tasteModel(all);
  return it => {
    if (seen[it.id]) return -10 - (seen[it.id] / 1e13) + Math.random() * 0.5; // seen: oldest-seen first
    const global = typeof it.score === 'number' ? (it.score - 0.5) * 1.2 : 0;
    return Math.random() + global + taste(it) * 0.6;
  };
}
// Round-robin across groups so a pool stays varied; within a group, best-ranked first.
function roundRobin(pool, keyOf, rank) {
  const groups = new Map();
  for (const it of pool) {
    const key = keyOf(it);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push([rank(it), it]);
  }
  const lists = [...groups.values()].map(l => l.sort((a, b) => a[0] - b[0])), out = [];
  while (lists.some(l => l.length)) {
    // each round, groups whose next item ranks higher go first
    for (const l of lists.filter(l => l.length).sort((a, b) => b.at(-1)[0] - a.at(-1)[0])) out.push(l.pop()[1]);
  }
  return out;
}
// Alternate motion (video/embeds) and stills one-for-one while motion lasts; curated picks lead each pool.
// Items this device voted down are left out.
function arrange(all) {
  const rank = ranker(all);
  const pool = all.filter(i => myVotes[i.id] !== -1);
  const isMotion = i => i.kind === 'video' || i.kind === 'embed';
  const byRank = list => list.map(i => [rank(i), i]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
  const motion = [...byRank(pool.filter(i => i.curated && isMotion(i))),
    ...roundRobin(pool.filter(i => !i.curated && isMotion(i)), i => i.id.split('-')[0], rank)];
  const stills = [...byRank(pool.filter(i => i.curated && !isMotion(i))),
    ...roundRobin(pool.filter(i => !i.curated && !isMotion(i)), i => i.source === 'iNaturalist' ? `inat:${i.topic}` : i.source, rank)];
  const out = [];
  while (motion.length || stills.length) {
    if (motion.length) out.push(motion.shift());
    if (stills.length) out.push(stills.shift());
  }
  return out;
}

// ---------- "Helped?" votes ----------
function sendVote(id, v, prev) {
  // text/plain keeps this a "simple" request (no CORS preflight); nothing identifying is sent.
  fetch('api/vote', { method: 'POST', body: JSON.stringify({ id, v, prev }), keepalive: true, headers: { 'Content-Type': 'text/plain' } })
    .catch(() => {});
}
function helpedBlock(it) {
  const up = el('button', { className: 'vote up', type: 'button', ariaLabel: 'Yes, this helped', title: 'Helped', textContent: '👍' });
  const down = el('button', { className: 'vote down', type: 'button', ariaLabel: "No, this didn't help", title: "Didn't help", textContent: '👎' });
  const paint = () => {
    up.setAttribute('aria-pressed', String(myVotes[it.id] === 1));
    down.setAttribute('aria-pressed', String(myVotes[it.id] === -1));
  };
  const vote = clicked => {
    const prev = myVotes[it.id] || 0;
    const v = prev === clicked ? 0 : clicked; // tapping the same thumb again undoes it
    if (v) myVotes[it.id] = v; else delete myVotes[it.id];
    store.set('ws.votes', myVotes);
    paint();
    sendVote(it.id, v, prev);
    if (v === -1) setTimeout(() => step(1), 450); // didn't help: move on
  };
  up.addEventListener('click', () => vote(1));
  down.addEventListener('click', () => vote(-1));
  paint();
  return el('div', { className: 'helped', role: 'group', ariaLabel: 'Did this help?' },
    el('span', { textContent: 'Helped?' }), up, down);
}

// ---------- rendering ----------
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k != null && k !== '') n.append(k);
  return n;
};

function infoBlock(it) {
  const topic = el('span', { className: 'topic' + (it.discovery ? ' discovery' : ''), textContent: it.topic || it.source });
  const credit = el('p', { className: 'credit' },
    [it.credit, it.license].filter(Boolean).join(' · ') + ' · ',
    el('a', { href: it.sourceUrl, target: '_blank', rel: 'noopener', textContent: `${it.source} ↗` }));
  return el('div', { className: 'info' },
    topic,
    el('h2', { textContent: it.title }),
    it.subtitle ? el('p', { className: 'sub', textContent: it.subtitle }) : null,
    it.caption ? el('p', { className: 'caption', textContent: it.caption }) : null,
    credit);
}

function makeCard(it) {
  const card = el('section', { className: 'card', tabIndex: -1 });
  card.dataset.id = it.id;
  card._item = it;
  const thumb = it.media.thumb || it.media.poster || it.media.src;
  if (thumb) card.append(el('div', { className: 'backdrop', style: `background-image:url("${thumb}")` }));
  card.append(infoBlock(it), helpedBlock(it));
  return card;
}

function dropCard(card) {
  if (card === active) active = null;
  card.remove();
}

// Mount the heavy part (image/video/iframe) only when the card is near the viewport.
function mount(card) {
  if (card._mounted) return;
  card._mounted = true;
  const it = card._item;
  let media;
  if (it.kind === 'image') {
    media = el('img', { className: 'media', alt: it.title, decoding: 'async', src: it.media.src });
    // Larger screens (wider than ~1200 device px: desktops, iPads) get the high-res rendition; phones keep the lighter one.
    if (it.media.hi) {
      media.srcset = `${it.media.src} 1200w, ${it.media.hi} 2048w`;
      media.sizes = '100vw';
    }
    media.addEventListener('load', () => media.classList.add('ready'));
    media.addEventListener('error', () => dropCard(card));
  } else if (it.kind === 'video') {
    media = el('video', { className: 'media', muted: true, defaultMuted: true, loop: true, playsInline: true, preload: 'metadata', poster: it.media.poster || '' });
    // iOS Safari only autoplays when these are real attributes, not just properties.
    for (const a of ['muted', 'playsinline', 'webkit-playsinline', 'loop']) media.setAttribute(a, '');
    // Prefer sources the browser is sure about (full codec string): Chromium can't decode Commons' MPEG-4 Part 2
    // .mov, so it must pick the WebM. Safari answers "" for some incomplete codec strings it can still play, so
    // if nothing matches that way, fall back to the bare MIME type and let the browser try in order.
    const full = s => media.canPlayType(s.type), bare = s => media.canPlayType(s.type.split(';')[0]);
    let playable = it.media.sources.filter(full)
      .sort((a, b) => (full(b) === 'probably') - (full(a) === 'probably'));
    if (!playable.length) playable = it.media.sources.filter(bare);
    if (!playable.length) return dropCard(card);
    for (const s of playable) media.append(el('source', { src: s.src, type: s.type }));
    // Show the poster right away: iOS doesn't load video data until playback starts, so waiting for
    // 'loadeddata' would leave a blank card whenever autoplay is blocked.
    if (it.media.poster) media.classList.add('ready');
    media.addEventListener('loadeddata', () => media.classList.add('ready'));
    media.lastElementChild.addEventListener('error', () => dropCard(card)); // every source failed
    media.addEventListener('click', () => setSound(!soundOn));
  } else if (it.kind === 'embed') {
    media = el('button', { className: 'facade', ariaLabel: `Play ${it.title}`, style: `background-image:url("${it.media.thumb}")` });
    media.addEventListener('click', () => mountEmbed(card));
  }
  if (media) card.insertBefore(media, card.querySelector('.info'));
  card._media = media;
}

function embedSrc(m, autoplay) {
  const mute = soundOn ? 0 : 1;
  if (m.provider === 'youtube')
    return `https://www.youtube-nocookie.com/embed/${m.id}?autoplay=${+autoplay}&mute=${mute}&playsinline=1&rel=0&modestbranding=1&loop=1&playlist=${m.id}`;
  if (m.provider === 'vimeo')
    return `https://player.vimeo.com/video/${m.id}?autoplay=${+autoplay}&muted=${mute}&loop=1&dnt=1&title=0&byline=0&portrait=0`;
  return '';
}
function mountEmbed(card, autoplay = true) {
  const it = card._item;
  if (card._media?.tagName === 'IFRAME') return;
  const frame = el('iframe', {
    className: 'media' + (it.media.vertical ? ' vertical' : ''), title: it.title,
    src: embedSrc(it.media, autoplay), allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
    allowFullscreen: true, loading: 'lazy',
  });
  frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  card._media.replaceWith(frame);
  card._media = frame;
}
function unmountEmbed(card) {
  if (card._media?.tagName !== 'IFRAME') return;
  card._mounted = false;
  card._media.remove();
  card._media = null;
  mount(card);
}

function activate(card) {
  if (active === card) return;
  if (active) deactivate(active);
  active = card;
  mount(card);
  const m = card._media;
  if (m?.tagName === 'VIDEO') playVideo(card, m);
  if (card._item.kind === 'embed' && !reduceMotion) mountEmbed(card, true);
  if (card.dataset.id) { history.replaceState(null, '', `#${card.dataset.id}`); markSeen(card.dataset.id); }
  // keep the feed topped up
  if (feedEl.lastElementChild === card || card.nextElementSibling === feedEl.lastElementChild) appendBatch();
}
// Autoplay can be refused (iPhone Low Power Mode, data saver, reduced motion): offer a tap-to-play button
// instead of leaving a still frame. A video that hasn't loaded after a while gets the same button, since on
// iOS a tap is sometimes what it takes to start loading.
function playVideo(card, m) {
  m.muted = !soundOn;
  const offer = () => showTapToPlay(card, m);
  if (reduceMotion) return offer();
  m.play().then(() => hideTapToPlay(card)).catch(offer);
  clearTimeout(card._stall);
  card._stall = setTimeout(() => { if (active === card && m.readyState < 2) offer(); }, 8000);
}
function showTapToPlay(card, m) {
  if (card._tap) return;
  const btn = el('button', { className: 'tap-play', type: 'button', ariaLabel: `Play ${card._item.title}` });
  btn.addEventListener('click', e => {
    e.stopPropagation();
    m.muted = !soundOn;
    m.play().then(() => hideTapToPlay(card)).catch(() => {});
  });
  card.insertBefore(btn, card.querySelector('.info'));
  card._tap = btn;
}
function hideTapToPlay(card) { card._tap?.remove(); card._tap = null; }
// Browsers hold back autoplay in hidden tabs; resume the current video when the page is shown again.
document.addEventListener('visibilitychange', () => {
  const m = active?._media;
  if (document.visibilityState === 'visible' && m?.tagName === 'VIDEO' && m.paused && !reduceMotion) playVideo(active, m);
});

function deactivate(card) {
  const m = card._media;
  clearTimeout(card._stall);
  if (m?.tagName === 'VIDEO') m.pause();
  if (card._item?.kind === 'embed') unmountEmbed(card);
}

const nearObserver = new IntersectionObserver(entries => {
  for (const e of entries) if (e.isIntersecting && e.target._item) mount(e.target);
}, { root: feedEl, rootMargin: '150% 0px' });

const activeObserver = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (e.isIntersecting && e.intersectionRatio >= 0.6) {
      if (e.target._item) activate(e.target);
      else if (active) { deactivate(active); active = null; }
    }
  }
}, { root: feedEl, threshold: [0.6] });

function appendBatch() {
  if (!items.length) return;
  for (let n = 0; n < BATCH; n++) {
    if (cursor >= items.length) { items = arrange(items); cursor = 0; } // endless: reshuffle and go again
    const card = makeCard(items[cursor++]);
    feedEl.append(card);
    nearObserver.observe(card);
    activeObserver.observe(card);
  }
}

// ---------- controls ----------
function setSound(on) {
  soundOn = on;
  soundBtn.setAttribute('aria-pressed', String(on));
  soundBtn.textContent = on ? 'Sound on' : 'Sound off';
  if (active?._media?.tagName === 'VIDEO') active._media.muted = !on;
  if (active?._item.kind === 'embed' && active._media?.tagName === 'IFRAME') {
    active._media.src = embedSrc(active._item.media, true);
  }
}
soundBtn.addEventListener('click', () => setSound(!soundOn));

const about = document.getElementById('about');
document.getElementById('about-open').addEventListener('click', () => about.showModal());

function step(dir) {
  const cards = [...feedEl.children];
  const i = cards.indexOf(active || cards[0]);
  const next = cards[Math.max(0, Math.min(cards.length - 1, i + dir))];
  next?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
}
document.addEventListener('keydown', e => {
  if (about.open || e.target.closest?.('input, textarea, button')) return;
  if (['ArrowDown', 'j', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); step(1); }
  if (['ArrowUp', 'k', 'PageUp'].includes(e.key)) { e.preventDefault(); step(-1); }
  if (e.key === 'm') setSound(!soundOn);
});

// ---------- boot ----------
activeObserver.observe(feedEl.querySelector('.intro'));
try {
  const res = await fetch('feed.json', { cache: 'no-cache' });
  const data = await res.json();
  items = arrange(data.items);
  // shared link (#id): show that item first
  const want = decodeURIComponent(location.hash.slice(1));
  const idx = want ? items.findIndex(i => i.id === want) : -1;
  if (idx > 0) items.unshift(...items.splice(idx, 1));
  appendBatch();
  if (idx >= 0) feedEl.children[1]?.scrollIntoView();
} catch (err) {
  feedEl.querySelector('.intro .hint').textContent = 'Could not load the feed. Try again in a moment.';
  console.error(err);
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// wundersnack feed: vertical, full-screen, swipeable. No framework, no tracking.
const feedEl = document.getElementById('feed');
const soundBtn = document.getElementById('sound');
const BATCH = 8;

let items = [];
let cursor = 0;
let soundOn = false;
let active = null;

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- ordering ----------
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// Round-robin across groups so a pool stays varied.
function roundRobin(pool, keyOf) {
  const groups = new Map();
  for (const it of shuffle(pool)) {
    const key = keyOf(it);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const lists = [...groups.values()], out = [];
  while (lists.some(l => l.length)) for (const l of shuffle(lists)) if (l.length) out.push(l.pop());
  return out;
}
// Alternate motion (video/embeds) and stills one-for-one while motion lasts; curated picks lead each pool.
function arrange(all) {
  const isMotion = i => i.kind === 'video' || i.kind === 'embed';
  const motion = [...shuffle(all.filter(i => i.curated && isMotion(i))),
    ...roundRobin(all.filter(i => !i.curated && isMotion(i)), i => i.id.split('-')[0])];
  const stills = [...shuffle(all.filter(i => i.curated && !isMotion(i))),
    ...roundRobin(all.filter(i => !i.curated && !isMotion(i)), i => i.source === 'iNaturalist' ? `inat:${i.topic}` : i.source)];
  const out = [];
  while (motion.length || stills.length) {
    if (motion.length) out.push(motion.shift());
    if (stills.length) out.push(stills.shift());
  }
  return out;
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
  card.append(infoBlock(it));
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
    media = el('video', { className: 'media', muted: true, loop: true, playsInline: true, preload: 'metadata', poster: it.media.poster || '' });
    media.setAttribute('playsinline', '');
    // Check the full codec string: Commons' .mov transcodes are MPEG-4 Part 2, which Chromium can't decode.
    const playable = it.media.sources.filter(s => media.canPlayType(s.type))
      .sort((a, b) => (media.canPlayType(b.type) === 'probably') - (media.canPlayType(a.type) === 'probably'));
    if (!playable.length) return dropCard(card);
    for (const s of playable) media.append(el('source', { src: s.src, type: s.type }));
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
  if (m?.tagName === 'VIDEO' && !reduceMotion) { m.muted = !soundOn; m.play().catch(() => {}); }
  if (card._item.kind === 'embed' && !reduceMotion) mountEmbed(card, true);
  if (card.dataset.id) history.replaceState(null, '', `#${card.dataset.id}`);
  // keep the feed topped up
  if (feedEl.lastElementChild === card || card.nextElementSibling === feedEl.lastElementChild) appendBatch();
}
function deactivate(card) {
  const m = card._media;
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
  if (about.open || e.target.closest?.('input, textarea')) return;
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

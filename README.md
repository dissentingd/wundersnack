# wundersnack

**A quick snack of wonder.** [wundersnack.com](https://wundersnack.com) is a full-screen, swipe-up feed of amazing animals, plants, tiny worlds, natural phenomena and new discoveries, made to give you a moment of relief.

The natural world is full of wonder most people never get to see. wundersnack puts some of it in front of you in a minute or two.

## What it is (and isn't)

- **Swipe or scroll** through photos, videos and short facts. On a phone, use *Add to Home Screen* to install it like an app.
- **Calm first.** Sources are filtered to leave out predation, death, disease, disasters and other distressing material.
- **A snack, not a meal.** After five minutes of looking, a break card suggests stopping. You can take one more five-minute snack; after that the feed pauses for an hour and offers a small offline suggestion instead ("Look up. What's the sky doing right now?"). Only time with the page visible counts, and the timer lives in your browser. Add `?snack=20` to the URL to try it with a 20-second snack.
- **No social layer.** No accounts, likes, comments, follower counts, ads or tracking.
- **"Helped?"** Each card asks whether it helped, with a thumbs up or down. A thumbs-up keeps you on the card; a thumbs-down moves on. Votes are counted anonymously per item, with no account, device id, cookie or IP stored, and they help the project rank and find content that actually helps. Your own votes and what you've already seen stay in your browser, so your feed adapts to you and keeps showing you new things first.
- **Credit always travels with the content.** Photos load from where they live. Videos from Wikimedia Commons are converted once to a format every phone can play and served from our own storage (`media.wundersnack.com`), with the original as automatic fallback. Every card shows the creator, license and a link back to the source. YouTube and Vimeo videos are embedded with their own players.

## Where the content comes from

| Source | What | License |
| --- | --- | --- |
| [iNaturalist](https://www.inaturalist.org/) | Research-grade, most-favourited observation photos for wonder-rich groups (fungi, slime molds, nudibranchs, radiolarians, tardigrades and more), plus a fact from Wikipedia about the species, or its genus, family, order or phylum | Each photo's own Creative Commons license; facts CC BY-SA |
| [NASA Image and Video Library](https://images.nasa.gov/) | Nebulae, aurorae, galaxies, Earth from space, and short science videos | Public domain (NASA) |
| [ESO](https://www.eso.org/public/news/) | Latest press releases: new discoveries about the universe | CC BY 4.0 |
| [Wikimedia Commons](https://commons.wikimedia.org/) | Short nature videos from the community's *Media of the day* picks: time-lapses, slow motion, microscopy. Copies converted to H.264 for iPhone compatibility | Each file's own license |
| Hand-picked (`curated.json`) | YouTube and Vimeo videos, embedded | The creator's own terms |

If you made something shown here and want it removed, or spot something that shouldn't be in a calm feed, please [open an issue](https://github.com/dissentingd/wundersnack/issues).

## How it works

It's a static site with no framework and no build step, deployed as a [Cloudflare Worker with static assets](https://developers.cloudflare.com/workers/static-assets/) on every push to `main`. A few lines of Worker code and a [D1](https://developers.cloudflare.com/d1/) database hold the anonymous vote counts; everything else is plain files.

```
index.html, assets/      the feed web app (vanilla JS, CSS scroll-snap)
manifest.webmanifest     makes it installable (PWA)
sw.js                    caches the app shell only, never media
feed.json                the generated index of items (links + credits, no media)
curated.json             hand-picked items, always included
sources.config.json      what to pull from each open source, and the calm filters
scripts/build-feed.mjs   builds feed.json from the sources above
scripts/add-curated.mjs  adds a YouTube/Vimeo video to curated.json
scripts/vote-report.mjs  what helps most, by source, topic and kind
scripts/cache-media.mjs  converts Commons videos to H.264 and stores them in Cloudflare R2
src/worker.js            POST /api/vote (one anonymous up/down) and GET /api/totals (public counts)
schema.sql               the votes table (the Worker creates it automatically on first use)
wrangler.jsonc           Worker config: static assets, D1 binding
.assetsignore            repo files that are not part of the website
_headers                 cache and security headers
.github/workflows/       weekly rebuild of feed.json
```

### Rebuild the feed

Requires Node 20 or newer; no dependencies to install.

```sh
node scripts/build-feed.mjs                     # all sources, about a minute and a half
node scripts/build-feed.mjs --only=eso,nasa     # just some sources
```

Then attach the cached video copies (no credentials needed; it reads the public manifest):

```sh
node scripts/cache-media.mjs
```

A source that fails or returns nothing keeps its items from the previous `feed.json`. The [refresh workflow](.github/workflows/refresh-feed.yml) runs this every Monday and commits the result; you can also run it by hand from the Actions tab.

### Video copies (Cloudflare R2)

Wikimedia Commons only offers its videos as MPEG-4 Part 2 or WebM, which iPhone Safari plays unreliably, and it rate-limits heavy hotlinking. `scripts/cache-media.mjs --upload` converts each new Commons video once with ffmpeg (H.264 + AAC, at most 1280 px wide and 30 fps) and uploads it, plus a poster frame, to an R2 bucket served at `mediaCache.baseUrl`. A public `manifest.json` in the bucket records what's cached. Cards list our copy first and the Commons originals after it, so playback falls back to Commons if our copy is unavailable.

The weekly workflow does this automatically (up to 60 new videos per run) when these repository secrets are set: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (an R2 API token with object read and write on the bucket). It uses the AWS CLI against R2's S3-compatible API. To test conversion locally without uploading: `node scripts/cache-media.mjs --dry-run=out --limit=3` (needs ffmpeg).

### Add a hand-picked video

```sh
node scripts/add-curated.mjs "https://www.youtube.com/watch?v=VIDEO_ID" "Why it's amazing, in a sentence or two." "Animals"
```

The script checks the video through the provider's oEmbed endpoint (so it must exist and allow embedding) and fills in the title and channel credit.

### Tune the filters

In `sources.config.json`:

- `calmBlocklist`: words that drop an item. Each entry is a case-insensitive regex matched at the start of a word, so `war\b` blocks "war" but not "warbler".
- `commons.natureAllowlist`: a Commons video is kept only if its title, description or categories match one of these.
- `exclude.ids`: feed item ids (for example `commons-12345` or `inat-67890`) to always leave out.
- `votes`: where to read vote totals, and when to drop an item (by default, 8 or more votes and under 25% helpful).
- Taxa, queries and per-source counts for each source.

### How votes shape the feed

- **For everyone:** each weekly rebuild reads `/api/totals` and gives every voted item a score, `(up + 1) / (up + down + 2)`. Higher-scoring items tend to come sooner; consistently unhelpful ones are dropped. A little randomness is always mixed in, so no single "top list" forms.
- **For you:** your browser remembers what you've seen and how you voted (in `localStorage`, never sent). Unseen items come first, items you voted down never return, and topics, sources and kinds (video or still) you liked are nudged forward.
- **For sourcing:** `node scripts/vote-report.mjs` summarises what helps by source, topic and kind, and lists the most and least helpful items.

### Run it locally

With the vote API (uses a local D1 database; no Cloudflare account needed), at <http://localhost:8787>:

```sh
npx wrangler dev
```

Or just the static site, without votes:

```sh
python -m http.server 8080
```

The service worker only registers over HTTPS, so local runs are never cached.

### Deploying your own copy

1. In Cloudflare, create a D1 database and put its id in `wrangler.jsonc` (`d1_databases[0].database_id`).
2. Create a Worker from this repository (Workers & Pages → Create → Import a repository). The defaults work: Cloudflare runs `npx wrangler deploy`, which reads `wrangler.jsonc`. The Worker's name must match `name` in `wrangler.jsonc`.
3. Point `votes.totalsUrl` in `sources.config.json` at your site's `/api/totals`.

## License

Code: [MIT](LICENSE). Content shown in the feed belongs to its creators and is used under each item's own license, as credited on every card.

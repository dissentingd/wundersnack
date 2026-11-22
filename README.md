# wundersnack

**A quick snack of wonder.** [wundersnack.com](https://wundersnack.com) is a full-screen, swipe-up feed of amazing animals, plants, tiny worlds, natural phenomena and new discoveries, made to give you a moment of relief.

The natural world is full of wonder most people never get to see. wundersnack puts some of it in front of you in a minute or two.

## What it is (and isn't)

- **Swipe or scroll** through photos, videos and short facts. On a phone, use *Add to Home Screen* to install it like an app.
- **Calm first.** Sources are filtered to leave out predation, death, disease, disasters and other distressing material.
- **No social layer.** No accounts, likes, comments, follower counts, ads or tracking.
- **"Helped?"** Each card asks whether it helped, with a thumbs up or down. A thumbs-up keeps you on the card; a thumbs-down moves on. Votes are counted anonymously per item, with no account, device id, cookie or IP stored, and they help the project rank and find content that actually helps. Your own votes and what you've already seen stay in your browser, so your feed adapts to you and keeps showing you new things first.
- **Nothing is re-hosted.** Every image and video is loaded from where it lives and shown with its creator, license and a link back to the source. Videos from YouTube and Vimeo are embedded with their own players.

## Where the content comes from

| Source | What | License |
| --- | --- | --- |
| [iNaturalist](https://www.inaturalist.org/) | Research-grade, most-favourited observation photos for wonder-rich groups (fungi, slime molds, nudibranchs, radiolarians, tardigrades and more), plus a species fact from Wikipedia | Each photo's own Creative Commons license; facts CC BY-SA |
| [NASA Image and Video Library](https://images.nasa.gov/) | Nebulae, aurorae, galaxies, Earth from space, and short science videos | Public domain (NASA) |
| [ESO](https://www.eso.org/public/news/) | Latest press releases: new discoveries about the universe | CC BY 4.0 |
| [Wikimedia Commons](https://commons.wikimedia.org/) | Short nature videos from the community's *Media of the day* picks: time-lapses, slow motion, microscopy | Each file's own license |
| Hand-picked (`curated.json`) | YouTube and Vimeo videos, embedded | The creator's own terms |

If you made something shown here and want it removed, or spot something that shouldn't be in a calm feed, please [open an issue](https://github.com/dissentingd/wundersnack/issues).

## How it works

It's a static site with no framework and no build step, hosted on [Cloudflare Pages](https://pages.cloudflare.com/), which deploys every push to `main`. Two small Pages Functions and a [D1](https://developers.cloudflare.com/d1/) database hold the anonymous vote counts.

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
functions/api/vote.js    POST /api/vote: one anonymous up/down for an item
functions/api/totals.js  GET /api/totals: vote counts per item (public)
lib/db.js, schema.sql    the votes table (created automatically on first use)
_headers                 cache and security headers for Cloudflare Pages
.github/workflows/       weekly rebuild of feed.json
```

### Rebuild the feed

Requires Node 20 or newer; no dependencies to install.

```sh
node scripts/build-feed.mjs                     # all sources, about a minute and a half
node scripts/build-feed.mjs --only=eso,nasa     # just some sources
```

A source that fails or returns nothing keeps its items from the previous `feed.json`. The [refresh workflow](.github/workflows/refresh-feed.yml) runs this every Monday and commits the result; you can also run it by hand from the Actions tab.

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

With the vote API (uses a local D1 database, no Cloudflare account needed):

```sh
npx wrangler pages dev . --d1 DB=wundersnack-votes
```

Or just the static site, without votes:

```sh
python -m http.server 8080
```

The service worker only registers over HTTPS, so local runs are never cached.

### Deploying your own copy

1. In Cloudflare, create a D1 database (any name).
2. Create a Pages project from this repository: no build command, build output directory `/`.
3. In the Pages project's settings, add a D1 binding named `DB` pointing at that database, then redeploy.
4. Point `votes.totalsUrl` in `sources.config.json` at your site's `/api/totals`.

## License

Code: [MIT](LICENSE). Content shown in the feed belongs to its creators and is used under each item's own license, as credited on every card.

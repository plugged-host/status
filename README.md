# plugged.host status

The status page at [status.plugged.host](https://status.plugged.host), and the Cloudflare Worker
that watches plugged.host from the outside, so the page keeps working when the panel is down..

## How it works

- **The page:** `index.html` plus one compiled stylesheet (Tailwind CSS v4, `assets/status.src.css`
  → `assets/status.v5.css`, committed). It reads `/data/current.json`, `history.json` and
  `incidents.json` (and there is an RSS feed at `/feed.xml`).
- **The Worker** (`worker.js`, `monitor/`): a Cron Trigger runs every minute in a SQLite Durable
  Object (`StatusMonitor`). Each tick it probes the website and the panel's `/up` itself, opens a
  TCP connection to every node's Wings port, and fetches the panel's own export for what only the
  panel knows (CPU and memory, incidents, maintenance). It merges the two and serves `/data/*` and
  `/feed.xml` itself, so when the panel is unreachable the page says "Panel: offline" instead of
  going blank.
- **Hosting:** Cloudflare Workers with static assets (`wrangler.jsonc` declares the cron and the
  Durable Object, so a deploy creates them), deployed by Workers Builds on every push to `main`.
  The [website](https://github.com/plugged-host/site) reads `/data/*` from this Worker through a
  service binding: deploy this one first when changing both.

## Working on it

```bash
npm install
npm run build:css        # or: npm run watch:css
npx wrangler dev         # local preview (keep --persist-to outside the repo)
```

Node.js 26 (`.node-version`).

## Security

Please report vulnerabilities privately, see [SECURITY.md](SECURITY.md).

## Licence

MIT, © noprofit.space, see [LICENSE](LICENSE). The plugged.host name and logo are not covered by
the licence.

Come say hi on [Discord](https://discord.gg/plugged-host-1502647500295635085).

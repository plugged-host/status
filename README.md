# plugged.host status

The status page at [status.plugged.host](https://status.plugged.host), and the Cloudflare Worker
that watches plugged.host from the outside, so the page keeps working when the panel is down.

## How it works

- **The page:** `index.html` plus one compiled stylesheet (Tailwind CSS v4, `assets/status.src.css`
  → `assets/status.v5.css`, committed). It reads `/data/current.json`, `history.json` and
  `incidents.json` (and there is an RSS feed at `/feed.xml`).
- **The Worker** `status-plugged` (`worker.js`, `monitor/`): a Cron Trigger runs every minute in a
  SQLite Durable Object (`StatusMonitor`). Each tick it probes the website and the panel's `/up`
  itself, opens a TCP connection to every node's Wings port, and fetches the panel's own export
  (`/data/*.json` on panel.plugged.host) for what only the panel knows (CPU and memory, incidents,
  maintenance). It merges the two and serves `/data/*` and `/feed.xml` itself, so when the panel is
  unreachable the page says "Panel: offline" instead of going blank.
- **Hosting:** Cloudflare Workers with static assets (`wrangler.jsonc` declares the cron and the
  Durable Object, so a deploy creates them). The repo root is the upload: `.assetsignore` keeps
  tooling, `monitor/` and these docs out of it; a new non-site file goes in there too. The
  [website](https://github.com/plugged-host/site) reads `/data/*` from this Worker through a service
  binding.

## Incidents and maintenance

Post them in the panel: Admin › Status (incidents with updates, or an override that puts every
component in `maintenance`). The Worker keeps the last list it fetched, so they stay on the page
while the panel is down. `PLANNED` in `monitor/operator.js` is only a fallback for when the panel
cannot be used; it needs a deploy. What the panel checks and exports: the panel's
[docs/features/status.md](https://github.com/plugged-host/panel/blob/main/docs/features/status.md).

## Working on it

```bash
npm install
npm run build:css        # after editing assets/status.src.css or the classes in index.html; commit the output
```

Node.js 26 (`.node-version`).

## Deploy and roll back

Pushing to `main` deploys: Workers Builds runs `npx wrangler deploy`. When a change touches
`/data/*` on both sides, deploy this one first, then the website.

Roll back by reverting the commit and pushing. In a hurry, Cloudflare's dashboard (Workers &
Pages › `status-plugged` › Deployments) rolls back to an earlier version at once; push the revert
afterwards so `main` matches what is served.

No secrets: the variables in `wrangler.jsonc` are public URLs. Node host names and ports come from
the panel's export at run time and never leave the Durable Object.

## Security

Please report vulnerabilities privately, see [SECURITY.md](SECURITY.md).

## Licence

MIT, © noprofit.space, see [LICENSE](LICENSE). The plugged.host name and logo are not covered by
the licence.

Come say hi on [Discord](https://discord.gg/plugged-host-1502647500295635085).

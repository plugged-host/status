/* Worker for status.plugged.host (Cloudflare Workers + static assets).

   Static files are served straight from the assets, with _headers and
   _redirects applied. This script runs for the run_worker_first routes in
   wrangler.jsonc (/data/*, /feed.xml), for paths with no matching asset (which
   get the assets' 404), and for the cron trigger.

   The status data is produced here, not on the panel box: every minute the
   cron asks the StatusMonitor Durable Object (monitor/monitor.js) to probe the
   website, the panel and every node from outside, merge that with the panel's
   own export while it is fresh, and store the four public files. So the page
   keeps working, and says "Panel: offline", when the panel box is down.

   /data/{current,history,incidents}.json, /data/feed.xml and /feed.xml are
   served from those stored files; no other /data name exists (the panel's
   targets.json carries hostnames and is never relayed). _headers does not
   apply to Worker responses, so the headers the page relies on are set here.
   Before the monitor has run once, or if its files are older than the pages'
   staleness limit (the cron stopped), the panel's export is relayed instead,
   as this Worker used to do.

   plugged.host's /data/* comes here through a service binding (html/). */

import { StatusMonitor, FILES } from './monitor/monitor.js';

export { StatusMonitor };

const PANEL = 'https://panel.plugged.host';
const DATA = /^\/data\/([a-z0-9_-]+\.(?:json|xml))$/;
const STALE_MS = 180_000;
/* Colo-local copy of the stored files, so page polls do not each become a
   Durable Object request (100,000 a day on the Free plan). */
const CACHE_SECONDS = 20;
const CACHE_PREFIX = '/__status-monitor-cache/';

const headersFor = name => ({
    'Content-Type': name.endsWith('.xml') ? 'application/rss+xml; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
});

const respond = (body, name, method) =>
    new Response(method === 'HEAD' ? null : body, { status: 200, headers: headersFor(name) });

function monitor(env) {
    const id = env.MONITOR.idFromName('plugged-host');
    return env.MONITOR.get(id, env.MONITOR_LOCATION ? { locationHint: env.MONITOR_LOCATION } : undefined);
}

/* The panel's own export file, as this Worker served it before the monitor. */
async function relayPanel(env, name, method) {
    const panel = String(env.PANEL_URL || PANEL).replace(/\/+$/, '');
    try {
        const upstream = await fetch(`${panel}/data/${name}`, { method, signal: AbortSignal.timeout(5000) });
        /* Never relay an upstream error body (e.g. a challenge page). */
        if (!upstream.ok) {
            upstream.body?.cancel().catch(() => {});
            return null;
        }
        return new Response(method === 'HEAD' ? null : upstream.body, { status: 200, headers: headersFor(name) });
    } catch {
        return null;
    }
}

async function serveData(request, env, ctx, name) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    }

    const cache = globalThis.caches?.default;
    const cacheKey = name => new Request(new URL(CACHE_PREFIX + name, request.url));
    const hit = await cache?.match(cacheKey(name)).catch(() => null);
    if (hit) return respond(hit.body, name, request.method);

    let stored = null;
    try {
        stored = await monitor(env).files();
    } catch (error) {
        console.error(`monitor unavailable: ${error?.message || error}`);
    }

    const body = stored?.files?.[name];
    if (body != null && Date.now() - stored.at <= STALE_MS) {
        if (cache) {
            const copy = file => new Response(stored.files[file], {
                headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': `max-age=${CACHE_SECONDS}` },
            });
            ctx.waitUntil(Promise.all(FILES.map(file => cache.put(cacheKey(file), copy(file)))).catch(() => {}));
        }
        return respond(body, name, request.method);
    }

    const relayed = await relayPanel(env, name, request.method);
    if (relayed) return relayed;
    if (body != null) return respond(body, name, request.method);
    return new Response(null, { status: 502 });
}

export default {
    async fetch(request, env, ctx) {
        const { pathname } = new URL(request.url);

        if (pathname === '/feed.xml') return serveData(request, env, ctx, 'feed.xml');
        const data = DATA.exec(pathname);
        if (data) {
            return FILES.includes(data[1])
                ? serveData(request, env, ctx, data[1])
                : new Response(null, { status: 404 });
        }

        return env.ASSETS.fetch(request);
    },

    /* Awaited, so a failed tick shows as a failed cron event. */
    async scheduled(_controller, env) {
        try {
            await monitor(env).tick();
        } catch (error) {
            console.error(`tick failed: ${error?.stack || error}`);
            throw error;
        }
    },
};

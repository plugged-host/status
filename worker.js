/* Worker for the static site (Cloudflare Workers + static assets).

   Static files are served straight from the assets, with _headers and
   _redirects applied. This script only runs for the run_worker_first routes in
   wrangler.jsonc and for paths with no matching asset (which get the assets'
   404).

   /data/* and /feed.xml proxy the panel's status export: _redirects cannot
   proxy to another host, and _headers does not apply to Worker responses, so
   the headers the page relies on are set here. Only a single exported file
   name is accepted (no slashes), so this can never reach any other panel
   route. When the panel is unreachable the page falls back to fetching it
   cross-origin itself.

   Kept verbatim-identical in html/ and status/. */

const PANEL = 'https://panel.plugged.host';
const DATA = /^\/data\/([a-z0-9_-]+\.(json|xml))$/;
const TYPES = {
    json: 'application/json; charset=utf-8',
    xml: 'application/rss+xml; charset=utf-8',
};

async function proxyPanelData(request, file, extension) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    }

    let upstream;
    try {
        upstream = await fetch(`${PANEL}/data/${file}`, { method: request.method });
    } catch {
        upstream = null;
    }

    /* Never relay an upstream error body (e.g. a challenge page) under this
       origin; the page only needs the status to decide on its fallback. */
    if (!upstream || !upstream.ok) {
        return new Response(null, { status: upstream?.status === 404 ? 404 : 502 });
    }

    return new Response(upstream.body, {
        status: 200,
        headers: {
            'Content-Type': TYPES[extension],
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Access-Control-Allow-Origin': '*',
            'X-Content-Type-Options': 'nosniff',
        },
    });
}

export default {
    async fetch(request, env) {
        const { pathname } = new URL(request.url);

        const data = DATA.exec(pathname);
        if (data) return proxyPanelData(request, data[1], data[2]);
        if (pathname === '/feed.xml') return proxyPanelData(request, 'feed.xml', 'xml');

        return env.ASSETS.fetch(request);
    },
};

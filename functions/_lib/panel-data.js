/* Same-origin proxy for the panel's status export (Cloudflare Pages Function).

   Pages' _redirects can only rewrite to paths on this site, never to another
   host, so /data/* is fetched from the panel here. Pages does not apply
   _headers to Function responses, so the headers the page relies on are set
   below. Only a single exported file name is accepted (no slashes, no dots
   beyond the extension), so this can never reach any other panel route. When
   the panel is unreachable the page falls back to fetching it cross-origin.

   Kept verbatim-identical in html/ and status/. */

const PANEL = 'https://panel.plugged.host';
const FILE = /^[a-z0-9_-]+\.(json|xml)$/;
const TYPES = {
    json: 'application/json; charset=utf-8',
    xml: 'application/rss+xml; charset=utf-8',
};

export async function proxyPanelData(request, file) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    }

    const match = FILE.exec(file);
    if (!match) {
        return new Response('Not found', { status: 404 });
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
            'Content-Type': TYPES[match[1]],
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Access-Control-Allow-Origin': '*',
            'X-Content-Type-Options': 'nosniff',
        },
    });
}

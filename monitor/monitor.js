/* StatusMonitor: the out-of-band prober behind status.plugged.host.

   One SQLite-backed Durable Object (a single instance, placed in western
   Europe next to the panel and the nodes) runs a tick for every cron minute:

     1. probes the website and the panel's /up over HTTPS from outside the
        panel box, and fetches the panel's own export (current, history,
        incidents) plus targets.json, the list of node host:port pairs;
     2. TCP-connects to every node in the last targets list it has seen (the
        list is kept here, so a dead panel still leaves it with targets);
     3. runs the panel's thresholds on the results, keeps 60 minutes of
        samples and 90 days of daily uptime, and
     4. composes the four public files (compose.js), stored ready to serve.

   Storage is a single key/value table plus one row per day, written a handful
   of rows per tick to stay far inside the Workers Free plan's daily limits.
   Hostnames and ports never leave this object. */

import { DurableObject } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';
import {
    HISTORY_DAYS, PANEL, RECENT_MS, SITE, composeCurrent, composeFeed, composeHistory, composeIncidents,
    countCheck, day, evaluateEndpoint, evaluateNode, isFresh, key,
} from './compose.js';

const HTTP_TIMEOUT_MS = 5000;
const TCP_TIMEOUT_MS = 3000;
/* A Worker invocation may have six connections open at once and makes 50
   subrequests on the Free plan. Probes go through a pool smaller than six so
   none waits for a slot with its timeout already running. */
const CONCURRENCY = 5;
const MAX_NODES = 36;
const MAX_BODY = 1_500_000; // a SQLite row is capped at 2 MB
const USER_AGENT = 'plugged.host status monitor (Cloudflare Worker)';

export const FILES = ['current.json', 'history.json', 'incidents.json', 'feed.xml'];

/* ---------------------------------------------------------------- probes --- */

function timeout(ms) {
    let timer;
    const promise = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); });
    return { promise, clear: () => clearTimeout(timer) };
}

/* 2xx = reachable. The body is never read. */
async function probeHttp(url, fetcher = null) {
    const started = Date.now();
    const limit = timeout(HTTP_TIMEOUT_MS);
    try {
        const init = { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) };
        const response = await Promise.race([
            fetcher ? fetcher(url, init) : fetch(url, { ...init, cache: 'no-store' }),
            limit.promise,
        ]);
        response.body?.cancel().catch(() => {});
        return { reachable: response.ok, http: response.status, ms: Date.now() - started };
    } catch (error) {
        return { reachable: false, http: null, ms: null, error: error?.message || 'error' };
    } finally {
        limit.clear();
    }
}

/* The site is the site-plugged Worker on the same zone. A same-zone fetch()
   reaches it while it is a Custom Domain; were it moved to a route, the fetch
   would fail by design, so a failed public probe is re-checked through the
   SITE service binding before the site is called unreachable. */
async function probeSite(url, binding) {
    const direct = await probeHttp(url);
    if (direct.reachable || !binding) return direct;

    const bound = await probeHttp(url, (target, init) => binding.fetch(target, init));
    if (!bound.reachable) return direct;
    console.warn(`website: public probe failed (${direct.http ?? direct.error}), service binding answered ${bound.http}; counted as reachable`);
    return { ...bound, via: 'binding' };
}

async function probeTcp(hostname, port) {
    const started = Date.now();
    const limit = timeout(TCP_TIMEOUT_MS);
    let socket = null;
    try {
        socket = connect({ hostname, port });
        socket.closed.catch(() => {});
        await Promise.race([socket.opened, limit.promise]);
        return { reachable: true, ms: Date.now() - started };
    } catch {
        return { reachable: false, ms: null };
    } finally {
        limit.clear();
        try { socket?.close().catch(() => {}); } catch { /* already gone */ }
    }
}

/* Body text of a panel export file, or null; `missing` tells 404 apart. */
async function fetchText(url) {
    try {
        const response = await fetch(url, {
            headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
            signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
            cache: 'no-store',
        });
        if (!response.ok) {
            response.body?.cancel().catch(() => {});
            return { text: null, missing: response.status === 404 };
        }
        const text = await response.text();
        return { text: text.length <= MAX_BODY ? text : null, missing: false };
    } catch {
        return { text: null, missing: false };
    }
}

/* Runs thunks with at most `limit` in flight; thunks never throw. */
async function pool(tasks, limit) {
    const results = new Array(tasks.length);
    let next = 0;
    const lanes = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
        while (next < tasks.length) {
            const index = next++;
            results[index] = await tasks[index]();
        }
    });
    await Promise.all(lanes);
    return results;
}

/* ------------------------------------------------------------ parsing ---- */

function parseJson(text) {
    if (typeof text !== 'string') return null;
    try {
        const value = JSON.parse(text);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
        return null;
    }
}

function parseList(text) {
    try {
        const value = JSON.parse(text);
        return Array.isArray(value) ? value : [];
    } catch {
        return [];
    }
}

/* FNV-1a, to notice a changed incident list without storing a second copy. */
function hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(16);
}

/* An export file is usable when it is schema 1 with a real generated_at. */
const exportFile = value => (value?.schema_version === 1 && Number.isFinite(Date.parse(value.generated_at)) ? value : null);

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/* targets.json: {"schema_version":1,"generated_at":…,"nodes":[{"label","host","port"}]}.
   Returns the validated list, or null when the file is not a valid list. */
export function parseTargets(text) {
    const value = parseJson(text);
    if (value?.schema_version !== 1 || !Array.isArray(value.nodes)) return null;
    const seen = new Set();
    const nodes = [];
    for (const node of value.nodes) {
        const label = typeof node?.label === 'string' ? node.label.trim() : '';
        const host = typeof node?.host === 'string' ? node.host.trim() : '';
        const port = Number(node?.port);
        if (!label || label.length > 64 || !HOST.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) continue;
        if (seen.has(key(label))) continue;
        seen.add(key(label));
        nodes.push({ label, host, port });
    }
    if (nodes.length > MAX_NODES) {
        console.warn(`targets: ${nodes.length} nodes listed, probing the first ${MAX_NODES} (subrequest limit)`);
        nodes.length = MAX_NODES;
    }
    return nodes;
}

/* -------------------------------------------------------------- object --- */

export class StatusMonitor extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        this.busySince = 0;
        this.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID');
        this.sql.exec('CREATE TABLE IF NOT EXISTS days (date TEXT PRIMARY KEY, data TEXT NOT NULL) WITHOUT ROWID');
    }

    read(k) {
        const rows = this.sql.exec('SELECT v FROM kv WHERE k = ?', k).toArray();
        return rows.length ? rows[0].v : null;
    }

    write(k, v) {
        this.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', k, v);
    }

    /* The composed files, for the Worker's fetch handler. */
    async files() {
        const rows = this.sql.exec("SELECT k, v FROM kv WHERE k IN ('out:at', 'out:current.json', 'out:history.json', 'out:incidents.json', 'out:feed.xml')").toArray();
        if (rows.length < FILES.length + 1) return null;
        const out = { files: {} };
        for (const row of rows) {
            if (row.k === 'out:at') out.at = Number(row.v);
            else out.files[row.k.slice(4)] = row.v;
        }
        return out;
    }

    /* One cron minute. Overlapping ticks (a slow minute) are skipped rather
       than counted twice. */
    async tick() {
        if (this.busySince && Date.now() - this.busySince < 55_000) return { skipped: true };
        this.busySince = Date.now();
        try {
            return await this.run();
        } finally {
            this.busySince = 0;
        }
    }

    async run() {
        const env = this.env;
        const panelUrl = String(env.PANEL_URL || 'https://panel.plugged.host').replace(/\/+$/, '');
        const panelHealthUrl = String(env.PANEL_HEALTH_URL || `${panelUrl}/up`);
        const siteUrl = String(env.SITE_URL || 'https://plugged.host');
        const started = Date.now();

        const state = parseJson(this.read('state')) || {};
        state.components ||= {};
        state.targets ||= [];
        state.samples ||= [];

        /* 1. Endpoints and the panel's export. */
        const [site, panel, currentFile, historyFile, incidentsFile, targetsFile] = await pool([
            () => probeSite(siteUrl, env.SITE),
            () => probeHttp(panelHealthUrl),
            () => fetchText(`${panelUrl}/data/current.json`),
            () => fetchText(`${panelUrl}/data/history.json`),
            () => fetchText(`${panelUrl}/data/incidents.json`),
            () => fetchText(`${panelUrl}/data/targets.json`),
        ], CONCURRENCY);

        if (targetsFile.text !== null) {
            const targets = parseTargets(targetsFile.text);
            if (targets) {
                state.targets = targets;
                state.targetsAt = started;
            } else {
                console.warn('targets.json is not a valid target list; keeping the last one');
            }
        }

        /* 2. Nodes, from the freshest list there is. */
        const targets = state.targets;
        const tcp = await pool(targets.map(target => () => probeTcp(target.host, target.port)), CONCURRENCY);

        /* The tick's instant is taken after the probes, so generated_at is
           never older than the evidence it describes. */
        const now = Date.now();

        /* 3. Thresholds. */
        const components = {};
        const evaluate = (k, evaluator, probe) => {
            components[k] = { ...evaluator(state.components[k], probe.reachable), reachable: probe.reachable, ms: probe.ms };
        };
        evaluate('site', evaluateEndpoint, site);
        evaluate('panel', evaluateEndpoint, panel);
        /* 503 is the panel saying it is down on purpose (Laravel's `artisan down`, a planned
           switch such as the move to v3): maintenance, not a miss. */
        if (panel.http === 503) {
            components.panel = { status: 'maintenance', failures: 0, healthy: 0, reachable: false, ms: panel.ms };
        }
        targets.forEach((target, i) => evaluate(`node:${key(target.label)}`, evaluateNode, tcp[i]));
        state.components = components; // nodes no longer listed drop out

        /* 4. The panel's export, cached for when it stops answering. */
        const current = this.refresh('current', currentFile.text, state);
        const history = this.refresh('history', historyFile.text, state);
        const incidents = this.refresh('incidents', incidentsFile.text, state);
        const panelFresh = isFresh(current, now);
        const historyFresh = isFresh(history, now);

        /* 5. Own records: minute samples (1 h) and daily uptime (90 days). */
        state.samples.push({
            t: now,
            site: site.reachable,
            panel: panel.reachable,
            nodes: Object.fromEntries(targets.map((target, i) => [target.label, tcp[i].reachable ? tcp[i].ms : null])),
        });
        state.samples = state.samples.filter(sample => sample.t > now - RECENT_MS);

        const today = day(now);
        const todayRow = parseJson(this.sql.exec('SELECT data FROM days WHERE date = ?', today).toArray()[0]?.data) || {};
        todayRow[key(SITE)] = countCheck(todayRow[key(SITE)], components.site.status);
        todayRow[key(PANEL)] = countCheck(todayRow[key(PANEL)], components.panel.status);
        for (const target of targets) {
            const verdict = components[`node:${key(target.label)}`];
            if (verdict.status !== 'unknown') todayRow[key(target.label)] = countCheck(todayRow[key(target.label)], verdict.status);
        }
        this.sql.exec('INSERT INTO days (date, data) VALUES (?, ?) ON CONFLICT (date) DO UPDATE SET data = excluded.data', today, JSON.stringify(todayRow));
        if (state.prunedOn !== today) {
            this.sql.exec('DELETE FROM days WHERE date < ?', day(now - HISTORY_DAYS * 86_400_000));
            state.prunedOn = today;
        }
        const ownDays = new Map(this.sql.exec('SELECT date, data FROM days').toArray().map(row => [row.date, parseJson(row.data) || {}]));

        /* 6. The public files. */
        const verdicts = {
            site: components.site,
            panel: components.panel,
            nodes: new Map(targets.map(target => [key(target.label), components[`node:${key(target.label)}`]])),
        };
        const incidentList = Array.isArray(incidents?.incidents) ? incidents.incidents : [];
        const currentOut = composeCurrent({
            now, panel: current, panelFresh, verdicts, targetLabels: targets.map(target => target.label), incidents: incidentList,
        });
        const historyOut = composeHistory({
            now, panel: history, panelFresh: historyFresh, labels: currentOut.components.map(row => row.label), ownDays,
        });
        const files = {
            'current.json': JSON.stringify(currentOut),
            'history.json': JSON.stringify(historyOut),
            'incidents.json': JSON.stringify(composeIncidents({ now, incidents: incidentList })),
            'feed.xml': await composeFeed({ now, incidents: incidentList, base: env.RSS_BASE_URL || 'https://status.plugged.host' }),
        };

        this.ctx.storage.transactionSync(() => {
            for (const [name, body] of Object.entries(files)) this.write(`out:${name}`, body);
            this.write('out:at', String(now));
            this.write('state', JSON.stringify(state));
        });

        const summary = {
            website: components.site.status,
            panel: components.panel.status,
            export: panelFresh ? 'fresh' : (current ? 'stale' : 'none'),
            targets: targets.length,
            reachable: tcp.filter(result => result.reachable).length,
            overall: currentOut.overall.status,
            ms: Date.now() - started,
        };
        console.log(`tick ${JSON.stringify(summary)}`);
        return summary;
    }

    /* Keeps the newest valid copy of a panel export file and returns it
       parsed: the one just fetched, else the cached one. A copy is written
       only when it changed (its generated_at, kept in the state row, moved;
       for incidents, the list itself), to spare row writes. */
    refresh(name, text, state) {
        state.exports ||= {};
        const fetched = exportFile(parseJson(text));

        if (name === 'incidents') {
            if (fetched) {
                const list = JSON.stringify(Array.isArray(fetched.incidents) ? fetched.incidents : []);
                const fingerprint = `${list.length}:${hash(list)}`;
                if (state.exports.incidents !== fingerprint) {
                    this.write('panel:incidents', list);
                    state.exports.incidents = fingerprint;
                }
                return fetched;
            }
            const cached = this.read('panel:incidents');
            return cached === null ? null : { schema_version: 1, incidents: parseList(cached) };
        }

        if (fetched) {
            if (state.exports[name] !== fetched.generated_at) {
                this.write(`panel:${name}`, text);
                state.exports[name] = fetched.generated_at;
            }
            return fetched;
        }
        return exportFile(parseJson(this.read(`panel:${name}`)));
    }
}

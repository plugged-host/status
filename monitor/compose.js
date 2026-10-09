/* Pure functions behind the status Worker: the reachability evaluator and the
   composition of current.json / history.json / incidents.json / feed.xml.

   Everything here mirrors the panel plugin plugged-host-status
   (StatusHealthEvaluator, StatusExporter) so the files keep the exact shapes
   status.v5.js and the marketing site's app.v4.js read. No I/O, no Cloudflare
   APIs: the Durable Object in monitor.js feeds it.

   Nothing composed here may carry a hostname or a port: node targets only
   contribute their label. */

export const FRESH_MS = 180_000; // the pages' own staleness limit (STALE_AFTER)
export const RECENT_MS = 60 * 60_000;
export const HISTORY_DAYS = 90;

/* StatusHealthEvaluator::priority */
const PRIORITY = { major_outage: 5, offline: 5, partial_outage: 4, degraded: 3, maintenance: 2, operational: 1 };
export const priority = status => PRIORITY[status] ?? 0;
export const worse = (a, b) => (priority(b) > priority(a) ? b : a);

/* Labels are compared the way status.v5.js does: trimmed, case-insensitive. */
export const key = value => String(value ?? '').trim().toLowerCase();

export const SITE = 'Website';
export const PANEL = 'Panel';

/* Carbon's toIso8601String() in UTC, which is what the panel exports. */
export const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');
export const day = ms => new Date(ms).toISOString().slice(0, 10);

export function isFresh(payload, now) {
    const at = Date.parse(payload?.generated_at);
    return Number.isFinite(at) && now - at <= FRESH_MS;
}

/* ------------------------------------------------------------ evaluator --- */

/* StatusHealthEvaluator::endpoint (Website, Panel): a miss is degraded at
   once and offline from the third in a row; the first good check after a miss
   is still degraded, the second is operational. */
export function evaluateEndpoint(previous, reachable) {
    const failures = previous?.failures || 0;
    if (reachable) {
        return { status: failures > 0 ? 'degraded' : 'operational', failures: 0, healthy: (previous?.healthy || 0) + 1 };
    }
    const misses = Math.min(failures + 1, 1000);
    return { status: misses >= 3 ? 'offline' : 'degraded', failures: misses, healthy: 0 };
}

/* StatusHealthEvaluator::node, reachability only (TCP gives no metrics, so no
   maintenance or CPU-pressure states): one miss is a blip and keeps the last
   status, the second is degraded, the third offline; coming back from an
   episode takes two good checks. 'unknown' until the first verdict. */
export function evaluateNode(previous, reachable) {
    const status = previous?.status || 'unknown';
    if (!reachable) {
        const failures = Math.min((previous?.failures || 0) + 1, 1000);
        return { status: failures >= 3 ? 'offline' : failures >= 2 ? 'degraded' : status, failures, healthy: 0 };
    }
    const recovering = status === 'degraded' || status === 'offline';
    const healthy = recovering ? (previous?.healthy || 0) + 1 : Math.max(2, previous?.healthy || 0);
    return { status: recovering && healthy < 2 ? 'degraded' : 'operational', failures: 0, healthy };
}

/* --------------------------------------------------- overall + incidents --- */

const IMPACT = { critical: 'major_outage', major: 'partial_outage', maintenance: 'maintenance' };

/* StatusExporter::currentPayload's incident pass: every unresolved incident
   raises the components it names (by label; "All systems" = every one) to its
   impact, never lowers them. */
export function applyIncidents(components, incidents) {
    for (const incident of Array.isArray(incidents) ? incidents : []) {
        if (!incident || incident.status === 'resolved') continue;
        const raised = IMPACT[incident.impact] || 'degraded';
        const names = (Array.isArray(incident.components) && incident.components.length ? incident.components : ['All systems']).map(key);
        const all = names.includes('all systems');
        for (const component of components) {
            if ((all || names.includes(key(component.label))) && priority(raised) > priority(component.status)) {
                component.status = raised;
            }
        }
    }
}

/* StatusExporter::overallStatus. components[0..1] are Website and Panel. */
export function overallStatus(components, nodeCount) {
    const statuses = components.map(component => component.status);
    const nodes = statuses.slice(2);
    if (statuses.slice(0, 2).some(s => s === 'offline' || s === 'major_outage') || statuses.includes('major_outage')) return 'major_outage';
    if (nodeCount > 0 && nodes.every(s => s === 'offline')) return 'major_outage';
    if (statuses.some(s => s === 'offline' || s === 'partial_outage')) return 'partial_outage';
    if (statuses.includes('degraded')) return 'degraded';
    if (statuses.includes('maintenance')) return 'maintenance';
    if (statuses.includes('unknown')) return 'unknown';
    return 'operational';
}

const OVERALL_LABEL = {
    operational: 'All systems operational',
    degraded: 'Degraded performance',
    maintenance: 'Maintenance in progress',
    partial_outage: 'Partial system outage',
    major_outage: 'Major system outage',
};

function overall(components, nodeCount, panelFresh) {
    const status = overallStatus(components, nodeCount);
    let message = status === 'operational'
        ? 'All monitored systems are reporting normally.'
        : 'One or more monitored systems require attention.';
    if (!panelFresh) message += ' Node resource figures are unavailable while the panel is not reporting.';
    return { status, label: OVERALL_LABEL[status] || 'Status unknown', message };
}

/* A component as exported: label, status, and the note only when there is one. */
const component = (label, status, note) => (note ? { label, status, note } : { label, status });

/* ------------------------------------------------------------ current ---- */

/**
 * @param {object} input
 * @param {number} input.now
 * @param {object|null} input.panel        the panel's current.json (fresh or not)
 * @param {boolean} input.panelFresh
 * @param {{site?: object, panel?: object, nodes: Map<string, object>}} input.verdicts  evaluated probe states
 * @param {string[]} input.targetLabels     node labels from the last targets list
 * @param {object[]} input.incidents        incidents[] from the last incidents.json
 */
export function composeCurrent({ now, panel, panelFresh, verdicts, targetLabels, incidents }) {
    const panelComponents = Array.isArray(panel?.components) ? panel.components : [];
    const panelNodes = Array.isArray(panel?.nodes) ? panel.nodes : [];
    const byLabel = list => new Map(list.filter(item => item && item.label != null).map(item => [key(item.label), item]));
    const componentOf = byLabel(panelComponents);
    const nodeOf = byLabel(panelNodes);
    const mine = label => verdicts.nodes.get(key(label));

    const site = component(SITE, verdicts.site?.status || 'unknown', componentOf.get(key(SITE))?.note);
    const panelRow = component(PANEL, verdicts.panel?.status || 'unknown', componentOf.get(key(PANEL))?.note);

    let nodeRows;
    let nodes;
    let global;

    if (panelFresh) {
        /* The panel's own view, with this Worker's verdicts on top: Website and
           Panel are replaced (outside is the vantage point that matters), each
           node keeps the worse of the panel's status and the TCP verdict. */
        nodeRows = panelComponents
            .filter(item => item && key(item.label) !== key(SITE) && key(item.label) !== key(PANEL))
            .map(item => {
                const verdict = mine(item.label)?.status;
                return component(item.label, verdict ? worse(item.status, verdict) : item.status, item.note);
            });
    } else {
        /* No usable export: nodes come from the targets list (or, before one
           was ever seen, from the last export) with the TCP verdict alone. */
        const labels = targetLabels.length ? targetLabels : panelNodes.map(node => node.label);
        nodeRows = labels.map(label => component(label, mine(label)?.status || 'unknown', componentOf.get(key(label))?.note));
    }

    const components = [site, panelRow, ...nodeRows];
    applyIncidents(components, incidents);

    /* An operator's manual control (shown with a note) wins outright on the
       panel; keep its status while the export is fresh. */
    if (panelFresh) {
        for (const row of components) {
            const source = componentOf.get(key(row.label));
            if (source?.note && source.status) row.status = source.status;
        }
    }

    const statusOf = new Map(components.map(row => [key(row.label), row.status]));

    if (panelFresh) {
        const reportedBy = Date.parse(panel.generated_at) - FRESH_MS;
        nodes = panelNodes.map(node => ({ ...node, status: statusOf.get(key(node.label)) ?? node.status }));
        global = {
            ...(panel.global || {}),
            /* The panel's rule (reported in the last 3 minutes and not
               offline), against the merged status. */
            reporting_nodes: nodes.filter(node => Date.parse(node.last_reported_at) >= reportedBy && node.status !== 'offline').length,
        };
    } else {
        nodes = nodeRows.map(row => {
            const verdict = mine(row.label);
            return {
                label: row.label,
                status: statusOf.get(key(row.label)),
                /* When the panel last had metrics from it: still true. */
                last_reported_at: nodeOf.get(key(row.label))?.last_reported_at ?? null,
                /* TCP connect time from this Worker's vantage point. */
                latency_ms: verdict?.reachable && Number.isFinite(verdict.ms) ? verdict.ms : null,
                metrics: null,
            };
        });
        global = {
            reporting_nodes: nodes.filter(node => mine(node.label)?.reachable && node.status !== 'offline').length,
            total_nodes: nodes.length,
            cpu_used: null,
            cpu_total: null,
            memory_used: null,
            memory_total: null,
            storage_used: null,
            storage_total: null,
        };
    }

    return {
        schema_version: 1,
        generated_at: iso(now),
        overall: overall(components, nodeRows.length, panelFresh),
        components,
        global,
        nodes,
    };
}

/* ------------------------------------------------------------ history ---- */

function dayEntry(date, record) {
    return record
        ? { date, status: record[2], total_checks: record[0], operational_checks: record[1] }
        : null;
}

const recorded = entry => entry && entry.status && entry.status !== 'unknown';

/**
 * @param {object} input
 * @param {number} input.now
 * @param {object|null} input.panel         the panel's history.json (fresh or not)
 * @param {boolean} input.panelFresh
 * @param {string[]} input.labels           uptime rows, in current.json's component order
 * @param {Map<string, object>} input.ownDays  date -> { label-key: [total, operational, worst] }
 */
export function composeHistory({ now, panel, panelFresh, labels, ownDays }) {
    const panelUptime = new Map((Array.isArray(panel?.uptime) ? panel.uptime : [])
        .filter(row => row && row.label != null)
        .map(row => [key(row.label), new Map((row.days || []).filter(Boolean).map(entry => [entry.date, entry]))]));

    const dates = [];
    for (let i = HISTORY_DAYS - 1; i >= 0; i--) dates.push(day(now - i * 86_400_000));

    const uptime = labels.map(label => {
        const k = key(label);
        const endpoint = k === key(SITE) || k === key(PANEL);
        const panelDays = panelUptime.get(k) || new Map();
        let checks = 0;
        let operational = 0;

        const days = dates.map(date => {
            const own = dayEntry(date, ownDays.get(date)?.[k]);
            const theirs = recorded(panelDays.get(date)) ? panelDays.get(date) : null;
            /* Website/Panel: own days are authoritative. Nodes: the panel's
               days while its export is fresh, own days otherwise. Either way
               the other source fills days the first one does not have. */
            const chosen = endpoint || !panelFresh ? (own || theirs) : (theirs || own);
            if (!chosen) return { date, status: 'unknown' };
            const entry = { date, status: chosen.status };
            if (chosen.total_checks != null) {
                entry.total_checks = Number(chosen.total_checks) || 0;
                entry.operational_checks = Number(chosen.operational_checks) || 0;
                checks += entry.total_checks;
                operational += entry.operational_checks;
            }
            return entry;
        });

        return {
            label,
            uptime_percent: checks > 0 ? Math.round((operational / checks) * 100 * 1000) / 1000 : 0,
            days,
        };
    });

    /* Minute CPU/memory series exist only on the panel. A stale copy is cut
       to the last hour, so the graphs empty out instead of freezing. */
    let recent = Array.isArray(panel?.recent) ? panel.recent : [];
    if (!panelFresh) {
        const from = now - RECENT_MS;
        recent = recent.filter(Boolean).map(series => {
            const keep = (series.times || []).map((t, i) => (Date.parse(t) >= from ? i : -1)).filter(i => i >= 0);
            return {
                label: series.label,
                times: keep.map(i => series.times[i]),
                cpu: keep.map(i => series.cpu?.[i] ?? 0),
                memory: keep.map(i => series.memory?.[i] ?? 0),
            };
        });
    }

    return { schema_version: 1, generated_at: iso(now), recent, uptime };
}

/* Folds one tick's verdicts into a day record: [total, operational, worst]. */
export function countCheck(record, status) {
    const [total, operational, worst] = record || [0, 0, null];
    return [total + 1, operational + (status === 'operational' ? 1 : 0), worst === null || priority(status) > priority(worst) ? status : worst];
}

/* ---------------------------------------------------------- incidents ---- */

export function composeIncidents({ now, incidents }) {
    return { schema_version: 1, generated_at: iso(now), incidents: Array.isArray(incidents) ? incidents : [] };
}

/* Laravel's e(): htmlspecialchars with ENT_QUOTES. */
const e = value => String(value ?? '').replace(/[&<>"']/g, char =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = n => String(n).padStart(2, '0');

/* Carbon's toRssString() for a UTC instant: "Sat, 19 Sep 2026 23:00:00 +0000". */
export function rssDate(ms) {
    const d = new Date(ms);
    return `${DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} `
        + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}

async function sha1(text) {
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* StatusExporter::rss, byte for byte (same guids, so readers do not see the
   panel's items and these as different entries). */
export async function composeFeed({ now, incidents, base }) {
    const link = `${String(base || '').replace(/\/+$/, '')}/`;
    let items = '';
    for (const incident of Array.isArray(incidents) ? incidents : []) {
        const description = incident.updates?.[0]?.message ?? incident.status;
        const started = Date.parse(incident.started_at);
        const date = rssDate(Number.isFinite(started) ? started : now);
        items += `<item><title>${e(incident.title)}</title><link>${e(link)}</link>`
            + `<guid isPermaLink="false">plugged-host-${await sha1(String(incident.title ?? '') + date)}</guid>`
            + `<pubDate>${date}</pubDate><description>${e(description)}</description></item>`;
    }
    return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>plugged.host incidents</title>`
        + `<link>${e(link)}</link><description>Operational updates for plugged.host.</description>`
        + `<lastBuildDate>${rssDate(now)}</lastBuildDate>${items}</channel></rss>`;
}

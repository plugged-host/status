/* ==========================================================================
   status.plugged.host — v4

   The vhost CSP is style-src 'self' with no 'unsafe-inline', so nothing here
   may emit an inline style attribute. Meter fills ship as data-p on the .meter
   and are applied afterwards through the CSSOM (applyMeters + @property --p),
   which CSP does not restrict. Every interpolated value is escapeHtml'd.
   ========================================================================== */

'use strict';

const root = document.documentElement;
const button = document.querySelector('[data-theme-toggle]');

/* -------------------------------------------------------------- theme ---- */

const THEME_KEY = 'plugged-host-theme';

/* Storage throws in some privacy modes; the theme must not take the page
   down with it. */
const readTheme = () => { try { return localStorage.getItem(THEME_KEY); } catch { return null; } };
const writeTheme = value => { try { localStorage.setItem(THEME_KEY, value); } catch { /* ignore */ } };

function setTheme(value) {
    root.dataset.theme = value;
    root.style.colorScheme = value;
    const next = value === 'light' ? 'dark' : 'light';
    button?.setAttribute('aria-label', `Switch to ${next} theme`);
    button?.setAttribute('title', `Switch to ${next} theme`);
}

setTheme(readTheme() || 'dark');

button?.addEventListener('click', () => {
    const current = root.dataset.theme || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    writeTheme(next);
    setTheme(next);
});


/* ------------------------------------------------------------ helpers ---- */

const labels = {
    operational: 'Operational',
    degraded: 'Degraded performance',
    maintenance: 'Under maintenance',
    partial_outage: 'Partial outage',
    major_outage: 'Major outage',
    offline: 'Offline',
    unknown: 'Unknown',
};

const incidentStatusLabels = {
    investigating: 'Investigating',
    identified: 'Identified',
    monitoring: 'Monitoring',
    resolved: 'Resolved',
};

const STALE_AFTER = 180000;

const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));

const number = value => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(Number(value || 0));

/* Storage is 1000-based, the way disks are sold (and PANEL_USE_BINARY_PREFIX=false
   in the panel). Memory is 1024-based: RAM is sized in powers of two, and wings
   reports the kernel's MemTotal, so a 96 GB box reads ~94 GiB usable here rather
   than "101 GB" from dividing binary bytes by 1000. */
const bytes = (value, binary = false) => {
    const n = Number(value || 0);
    if (!n) return '0 B';
    const base = binary ? 1024 : 1000;
    const units = binary ? ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] : ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.min(Math.floor(Math.log(n) / Math.log(base)), units.length - 1);
    return `${number(n / base ** i)} ${units[i]}`;
};

const clock = value => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(value));

const time = value => {
    const date = new Date(value);
    return Number.isNaN(date.valueOf())
        ? 'Unknown'
        : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(date);
};

const relative = value => {
    const seconds = Math.max(0, (Date.now() - new Date(value).valueOf()) / 1000);
    if (!Number.isFinite(seconds)) return 'unknown';
    if (seconds < 60) return `${Math.round(seconds)}s ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
    return `${Math.round(seconds / 3600)}h ago`;
};

const pct = (used, total) => total > 0 ? Math.min(100, Math.max(0, used / total * 100)) : 0;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/* A key that survives label casing/spacing differences between the
   components[], nodes[] and incidents[].components label strings. */
const key = value => String(value ?? '').trim().toLowerCase();

/* ------------------------------------------------- uptime (client-side) --- */

/* The export pads uptime[].days[] to 90 entries, oldest first, filling the
   pre-monitoring window with 'unknown'. Recorded days carry total_checks and
   operational_checks, so a window's % is check-weighted exactly like
   uptime_percent: one degraded minute costs a minute, not the whole day.
   Exports without the counts fall back to counting clean days. */
function uptimeWindow(days, span) {
    const slice = days.slice(-span);
    const recorded = slice.filter(d => d && d.status && d.status !== 'unknown');
    if (!recorded.length) return null;
    const checks = recorded.reduce((n, d) => n + (Number(d.total_checks) || 0), 0);
    const percent = checks > 0
        ? recorded.reduce((n, d) => n + (Number(d.operational_checks) || 0), 0) / checks * 100
        : recorded.filter(d => d.status === 'operational').length / recorded.length * 100;
    return { percent, recorded: recorded.length };
}

/* Consecutive operational days counting back from the most recent entry. */
function currentStreak(days) {
    let streak = 0;
    for (let i = days.length - 1; i >= 0; i--) {
        const status = days[i] && days[i].status;
        if (status === 'operational') streak++;
        else if (status && status !== 'unknown') break;
        else break;
    }
    return streak;
}

function uptimeStats(days) {
    const list = Array.isArray(days) ? days : [];
    return {
        d7: uptimeWindow(list, 7),
        d30: uptimeWindow(list, 30),
        d90: uptimeWindow(list, 90),
        streak: currentStreak(list),
    };
}

function windowStat(label, window) {
    if (!window) return `<span class="stat"><b>—</b><span>${escapeHtml(label)}</span></span>`;
    return `<span class="stat"><b>${number(window.percent)}%</b><span>${escapeHtml(label)}</span></span>`;
}

function uptimeWindowsHtml(stats) {
    return `<div class="uptime-windows">`
        + windowStat('7d', stats.d7)
        + windowStat('30d', stats.d30)
        + windowStat('90d', stats.d90)
        + (stats.streak > 0 ? `<span class="stat"><b>${stats.streak}</b><span>day streak</span></span>` : '')
        + `</div>`;
}

/* ------------------------------------------------------------- meters ---- */

/* data-p is a plain attribute, so it survives innerHTML under a strict CSP.
   The width itself is applied by applyMeters() once the node is in the DOM. */
function metric(label, used, total, kind, series = null) {
    const percentage = pct(used, total);
    const binary = kind === 'memory';
    const value = kind === 'cpu' ? `${number(used)}% / ${number(total)}%` : `${bytes(used, binary)} / ${bytes(total, binary)}`;
    return `<article class="metric">`
        + `<span class="metric-label">${escapeHtml(label)}</span>`
        + `<strong class="metric-value">${value}</strong>`
        + `<div class="meter" data-p="${percentage.toFixed(2)}" role="progressbar" aria-label="${escapeHtml(label)} utilization"`
        + ` aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(percentage)}"><i></i></div>`
        + (series ? sparkline(label, kind, series, total) : '')
        + `<small>${number(percentage)}% utilized</small>`
        + `</article>`;
}

function applyMeters(container) {
    container.querySelectorAll('.meter[data-p]').forEach(meter => {
        const value = Number(meter.dataset.p) || 0;
        meter.classList.toggle('warn', value >= 75 && value < 90);
        meter.classList.toggle('hot', value >= 90);
        meter.firstElementChild?.style.setProperty('--p', value.toFixed(2));
    });
}

/* ---------------------------------------------------------- sparklines --- */

/* history.json recent[] covers the last 60 minutes, one point per collector
   run, with times[] parallel to the values. Unreachable minutes are omitted,
   so a gap longer than GAP_MS breaks the line instead of bridging it. */
const WINDOW_MS = 60 * 60 * 1000;
const GAP_MS = 150 * 1000;

/* Hover data per rendered sparkline, keyed by data-spark. The SVG only holds
   geometry; the readout is built from here with textContent. */
const sparks = new Map();

/* The y axis is capacity-scaled (0 to the node's total), not stretched to the
   series' own peak, so the line height agrees with the meter above it. */
function sparkline(label, kind, series, total) {
    const values = series.values || [];
    const timed = Number.isFinite(series.end) && (series.times || []).length === values.length;
    const points = values
        .map((v, i) => ({ v: Number(v), t: timed ? Date.parse(series.times[i]) : null }))
        .filter(p => Number.isFinite(p.v) && (!timed || Number.isFinite(p.t)))
        .slice(-60);
    if (points.length < 2) return '';

    const capacity = total > 0 ? total : Math.max(...points.map(p => p.v), 1);
    const start = series.end - WINDOW_MS;
    points.forEach((p, i) => {
        p.x = timed ? Math.min(100, Math.max(0, (p.t - start) / WINDOW_MS * 100)) : i / (points.length - 1) * 100;
        p.pct = pct(p.v, capacity);
        p.y = 57 - p.pct * 0.53;
    });

    const segments = [];
    points.forEach((p, i) => {
        if (i === 0 || (timed && p.t - points[i - 1].t > GAP_MS)) segments.push([]);
        segments[segments.length - 1].push(p);
    });
    const shapes = segments.filter(s => s.length > 1).map(s => {
        const line = s.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
        return `<polygon class="area" points="${s[0].x.toFixed(2)},58 ${line} ${s[s.length - 1].x.toFixed(2)},58"></polygon>`
            + `<polyline points="${line}"></polyline>`;
    }).join('');

    const id = String(sparks.size);
    const spark = { kind, points };
    sparks.set(id, spark);
    const last = points.length - 1;
    const latest = readout(spark, points[last]);

    return `<div class="spark-wrap" data-spark="${id}" tabindex="0" role="slider"`
        + ` aria-label="${escapeHtml(label)} over the last 60 minutes" aria-valuemin="0" aria-valuemax="${last}"`
        + ` aria-valuenow="${last}" aria-valuetext="${escapeHtml(`${latest.value}, ${latest.detail}`)}">`
        + `<svg class="spark" viewBox="0 0 100 58" preserveAspectRatio="none" aria-hidden="true">${shapes}</svg>`
        + `<i class="spark-x"></i><i class="spark-dot"></i></div>`;
}

/* Value leads (utilization %), the time follows; memory also names the bytes. */
function readout(spark, point) {
    const detail = [
        spark.kind === 'memory' ? bytes(point.v, true) : null,
        point.t != null ? clock(point.t) : null,
    ].filter(Boolean).join(' · ');
    return { value: `${number(point.pct)}%`, detail };
}

/* One floating readout for the page. It lives on <body> because .metric clips
   its overflow, and it is positioned through the CSSOM (--tx/--ty) for the CSP. */
const tip = document.createElement('div');
tip.className = 'spark-tip';
tip.hidden = true;
tip.setAttribute('aria-hidden', 'true');
tip.append(document.createElement('strong'), document.createElement('span'));
document.body.append(tip);
let activeSpark = null;

function showPoint(wrap, index) {
    const spark = sparks.get(wrap.dataset.spark);
    const point = spark?.points[index];
    if (!point) return;
    if (activeSpark && activeSpark !== wrap) activeSpark.classList.remove('is-active');
    activeSpark = wrap;

    const { value, detail } = readout(spark, point);
    wrap.dataset.index = String(index);
    wrap.classList.add('is-active');
    wrap.style.setProperty('--x', point.x.toFixed(2));
    wrap.style.setProperty('--y', (point.y / 58 * 100).toFixed(2));
    wrap.setAttribute('aria-valuenow', String(index));
    wrap.setAttribute('aria-valuetext', `${value}, ${detail}`);

    tip.firstElementChild.textContent = value;
    tip.lastElementChild.textContent = detail;
    tip.hidden = false;
    const box = wrap.getBoundingClientRect();
    const half = tip.offsetWidth / 2;
    const x = Math.min(window.innerWidth - half - 8, Math.max(half + 8, box.left + box.width * point.x / 100));
    const y = box.top + box.height * point.y / 58;
    tip.style.setProperty('--tx', x.toFixed(1));
    tip.style.setProperty('--ty', y.toFixed(1));
    tip.classList.toggle('below', y - tip.offsetHeight - 12 < 0);
}

function hidePoint() {
    activeSpark?.classList.remove('is-active');
    activeSpark = null;
    tip.hidden = true;
}

function nearestPoint(points, x) {
    let best = 0;
    points.forEach((p, i) => { if (Math.abs(p.x - x) < Math.abs(points[best].x - x)) best = i; });
    return best;
}

function bindSparks(container) {
    container.querySelectorAll('.spark-wrap[data-spark]').forEach(wrap => {
        const spark = sparks.get(wrap.dataset.spark);
        if (!spark) return;
        const last = spark.points.length - 1;
        const track = event => {
            const box = wrap.getBoundingClientRect();
            showPoint(wrap, nearestPoint(spark.points, (event.clientX - box.left) / box.width * 100));
        };
        wrap.addEventListener('pointermove', track);
        wrap.addEventListener('pointerdown', track);
        /* A lifted finger also fires pointerleave; touch readouts stay until
           the next tap elsewhere or a scroll. */
        wrap.addEventListener('pointerleave', event => { if (event.pointerType !== 'touch') hidePoint(); });
        /* Keyboard focus starts at the latest point; a pointer that focused it has
           already picked its own point. */
        wrap.addEventListener('focus', () => { if (activeSpark !== wrap) showPoint(wrap, last); });
        wrap.addEventListener('blur', hidePoint);
        wrap.addEventListener('keydown', event => {
            if (event.key === 'Escape') { hidePoint(); return; }
            const current = Number(wrap.dataset.index ?? last);
            const next = { ArrowLeft: current - 1, ArrowDown: current - 1, ArrowRight: current + 1, ArrowUp: current + 1, Home: 0, End: last }[event.key];
            if (next === undefined) return;
            event.preventDefault();
            showPoint(wrap, Math.min(last, Math.max(0, next)));
        });
    });
}

document.addEventListener('pointerdown', event => {
    if (activeSpark && !activeSpark.contains(event.target)) hidePoint();
});
window.addEventListener('scroll', hidePoint, { passive: true });
window.addEventListener('resize', hidePoint);

/* --------------------------------------------------- incident indexing --- */

/* Active = not resolved. Build a label -> incident map so component and node
   rows can surface the incident that affects them. incidents[].components are
   LABEL strings, matched case-insensitively against component/node labels. */
function indexActiveIncidents(incidents) {
    const active = (incidents || []).filter(i => i && i.status && i.status !== 'resolved');
    const byLabel = new Map();
    active.forEach(incident => {
        (incident.components || []).forEach(label => {
            const k = key(label);
            if (!byLabel.has(k)) byLabel.set(k, incident);
        });
    });
    return { active, byLabel };
}

function flagFor(label, byLabel) {
    const incident = byLabel.get(key(label));
    if (!incident) return '';
    const impact = escapeHtml(incident.impact || 'minor');
    const state = escapeHtml(incidentStatusLabels[incident.status] || incident.status || 'active');
    return `<a class="flag impact-${impact}" href="#incidents" title="${escapeHtml(incident.title || 'Active incident')}">`
        + `<i></i>${state}</a>`;
}

/* ------------------------------------------------------------ renders ---- */

function renderCurrent(data, history, incidentIndex) {
    hidePoint();
    sparks.clear();
    const generated = new Date(data.generated_at);
    const stale = !Number.isFinite(generated.valueOf()) || Date.now() - generated.valueOf() > STALE_AFTER;

    document.querySelector('[data-updated]').textContent = data.generated_at
        ? `${time(data.generated_at)} (${relative(data.generated_at)})`
        : 'Waiting for data';

    const state = stale ? 'unknown' : (data.overall?.status || 'unknown');
    const overall = document.querySelector('[data-overall]');
    overall.className = `overall status-${state}`;
    overall.querySelector('strong').textContent = stale
        ? 'Monitoring data delayed'
        : (data.overall?.label || labels[state] || labels.unknown);
    overall.querySelector('span').textContent = stale
        ? 'The last update is over three minutes old. Values below may be stale.'
        : (data.overall?.message || 'All monitored systems are reporting normally.');

    /* Active-incident affordance on the banner. */
    const flag = overall.querySelector('[data-overall-flag]');
    if (flag) {
        const count = incidentIndex.active.length;
        if (count > 0) {
            flag.hidden = false;
            flag.innerHTML = `<i></i>${plural(count, 'active incident')}`;
        } else {
            flag.hidden = true;
            flag.textContent = '';
        }
    }

    /* Node labels drive de-duplication: components[] often repeats each node,
       so the Services list shows only entries that are not a node row. */
    const nodeLabels = new Set((data.nodes || []).map(n => key(n.display_name ?? n.label)));
    const uptimeByLabel = new Map((history.uptime || []).map(u => [key(u.label), u]));

    const services = (data.components || []).filter(item => !nodeLabels.has(key(item.label)));
    const components = document.querySelector('[data-components]');
    components.innerHTML = services.map(item => {
        const note = item.note ? `<p class="component-note">${escapeHtml(item.note)}</p>` : '';
        return `<div class="component"><div class="component-main">`
            + `<span class="component-name"><i class="dot ${escapeHtml(item.status)}"></i>${escapeHtml(item.label)}</span>`
            + note
            + `</div><div class="component-side">`
            + flagFor(item.label, incidentIndex.byLabel)
            + `<span class="component-state">${escapeHtml(labels[item.status] || item.status)}</span>`
            + `</div></div>`;
    }).join('')
        || '<div class="component"><div class="component-main"><span class="component-name"><i class="dot unknown"></i>Monitoring</span></div>'
        + '<div class="component-side"><span class="component-state">Waiting</span></div></div>';

    const global = data.global || {};
    document.querySelector('[data-reporting]').textContent =
        `${global.reporting_nodes || 0} of ${global.total_nodes || 0} nodes reporting`;

    const globalGrid = document.querySelector('[data-global]');
    globalGrid.innerHTML = metric('CPU', global.cpu_used, global.cpu_total, 'cpu')
        + metric('Memory', global.memory_used, global.memory_total, 'memory')
        + metric('Storage', global.storage_used, global.storage_total, 'storage');
    applyMeters(globalGrid);

    const recent = history.recent || [];
    const historyEnd = Date.parse(history.generated_at);
    const nodes = document.querySelector('[data-nodes]');
    nodes.innerHTML = (data.nodes || []).map(node => {
        const name = node.display_name ?? node.label;
        const series = recent.find(item => key(item.label) === key(name) || key(item.label) === key(node.label)) || {};
        const uptime = uptimeByLabel.get(key(name)) || uptimeByLabel.get(key(node.label));
        const stats = uptime ? uptimeStats(uptime.days) : null;

        /* Latency: prefer node.latency_ms, fall back to metrics.response_time_ms.
           Render the row only when a value is actually present. */
        const latency = node.latency_ms != null
            ? node.latency_ms
            : (node.metrics?.response_time_ms != null ? node.metrics.response_time_ms : null);

        const statChips = [];
        if (latency != null) statChips.push(`<span class="stat"><b>${number(latency)} ms</b><span>latency</span></span>`);
        if (stats?.d30) statChips.push(`<span class="stat"><b>${number(stats.d30.percent)}%</b><span>30d uptime</span></span>`);
        if (stats?.d90) statChips.push(`<span class="stat"><b>${number(stats.d90.percent)}%</b><span>90d uptime</span></span>`);
        if (stats?.streak > 0) statChips.push(`<span class="stat"><b>${stats.streak}</b><span>day streak</span></span>`);

        return `<article class="node"><header class="node-head"><div class="node-head-main">`
            + `<span class="node-title"><i class="dot ${escapeHtml(node.status)}"></i>${escapeHtml(name)}</span>`
            + `<span class="node-meta">${node.last_reported_at
                ? `Last reported ${escapeHtml(relative(node.last_reported_at))}`
                : 'No successful report'}</span></div>`
            + `<div class="node-side">`
            + flagFor(name, incidentIndex.byLabel)
            + `<span class="component-state">${escapeHtml(labels[node.status] || node.status)}</span>`
            + `</div></header>`
            + `<div class="resource-grid">`
            + metric('CPU', node.metrics?.cpu_used, node.metrics?.cpu_total, 'cpu', { values: series.cpu, times: series.times, end: historyEnd })
            + metric('Memory', node.metrics?.memory_used, node.metrics?.memory_total, 'memory', { values: series.memory, times: series.times, end: historyEnd })
            + metric('Storage', node.metrics?.storage_used, node.metrics?.storage_total, 'storage')
            + `</div>`
            + (statChips.length ? `<div class="node-stats">${statChips.join('')}</div>` : '')
            + `</article>`;
    }).join('') || '<div class="empty">No node data has been published yet.</div>';
    applyMeters(nodes);
    bindSparks(nodes);
}

function renderHistory(data) {
    document.querySelector('[data-uptime]').innerHTML = (data.uptime || []).map(item => {
        const days = item.days || [];
        /* The export always pads to 90 entries, filling days from before the
           first collection run with 'unknown'. Saying "99.8% over 90 days"
           when only a handful were observed would overstate the record, so
           the footnote reports how many days actually carry a check. */
        const recorded = days.filter(day => day && day.status && day.status !== 'unknown').length;
        const blank = days.length - recorded;
        const stats = uptimeStats(days);
        const bars = days.map(day =>
            `<i class="bar ${escapeHtml(day?.status || 'unknown')}" title="${escapeHtml(day?.date || 'No data')}: `
            + `${escapeHtml(labels[day?.status] || 'No data')}"></i>`
        ).join('');

        return `<article class="uptime-row"><div class="uptime-title">`
            + `<span>${escapeHtml(item.label)}</span>`
            + `<span>${number(item.uptime_percent)}% uptime</span></div>`
            + uptimeWindowsHtml(stats)
            + `<div class="bars" aria-label="Daily uptime for ${escapeHtml(item.label)}">${bars}</div>`
            + `<p class="uptime-foot">${plural(recorded, 'day')} of recorded checks`
            + (blank > 0 ? ` · ${plural(blank, 'day')} before monitoring started` : '')
            + `</p></article>`;
    }).join('') || '<div class="empty">Uptime history will build after monitoring begins.</div>';
}

function renderIncidents(data) {
    document.querySelector('[data-incidents]').innerHTML = (data.incidents || []).map(incident => {
        const isActive = incident.status && incident.status !== 'resolved';
        const liveBadge = isActive
            ? `<span class="badge live">${escapeHtml(incidentStatusLabels[incident.status] || incident.status)}</span>`
            : '';
        return `<article class="incident${isActive ? ' is-active' : ''}"><header class="incident-head"><div>`
            + `<h3>${escapeHtml(incident.title)}</h3>`
            + `<span class="incident-time">${escapeHtml(incident.started_at ? time(incident.started_at) : '')}`
            + `${incident.resolved_at ? ` · resolved ${escapeHtml(time(incident.resolved_at))}` : ''}</span></div>`
            + `<span class="incident-badges">${liveBadge}`
            + `<span class="badge ${escapeHtml(incident.impact)}">${escapeHtml(incident.impact)}</span></span></header>`
            + `<p class="incident-components">Affected: `
            + `${escapeHtml((incident.components || []).join(', ') || 'General service')}</p>`
            + `<ol class="updates">${(incident.updates || []).map(update =>
                `<li><strong>${escapeHtml(incidentStatusLabels[update.status] || update.status)} · `
                + `${escapeHtml(time(update.published_at))}</strong>`
                + `<p>${escapeHtml(update.message)}</p></li>`).join('')}</ol></article>`;
    }).join('') || '<div class="empty">No incidents reported.</div>';
}

/* --------------------------------------------------------------- fetch ---- */

const PRIMARY_DATA_ORIGIN = 'https://panel.plugged.host';

function getDataOrigin() {
    const meta = document.querySelector('meta[name="status-origin"]');
    if (meta && meta.content) return meta.content.replace(/\/+$/, '');
    if (typeof window !== 'undefined' && window.STATUS_ORIGIN) return String(window.STATUS_ORIGIN).replace(/\/+$/, '');
    return PRIMARY_DATA_ORIGIN;
}

async function fetchStatusFiles(baseUrl = '') {
    const prefix = baseUrl ? baseUrl.replace(/\/+$/, '') : '';
    const responses = await Promise.all([
        fetch(`${prefix}/data/current.json`, { cache: 'no-store' }),
        fetch(`${prefix}/data/history.json`, { cache: 'no-store' }),
        fetch(`${prefix}/data/incidents.json`, { cache: 'no-store' }),
    ]);
    if (!responses.every(response => response.ok)) {
        throw new Error(`HTTP ${responses.map(r => r.status).join(',')}`);
    }
    return Promise.all(responses.map(response => response.json()));
}

function isDataFresh(currentData) {
    if (!currentData || !currentData.generated_at) return false;
    const generated = new Date(currentData.generated_at).valueOf();
    return Number.isFinite(generated) && (Date.now() - generated) <= STALE_AFTER;
}

async function load() {
    let current = null;
    let history = null;
    let incidents = null;
    const backendOrigin = getDataOrigin();

    // 1. Try local relative fetch (/data/*.json). On Cloudflare Pages a Function
    //    (functions/data) proxies it to the panel, so the "local" path is live data.
    try {
        const [c, h, i] = await fetchStatusFiles('');
        if (c) {
            current = c;
            history = h;
            incidents = i;
        }
    } catch {
        // Local fetch failed (e.g. static host without backend or network issue).
    }

    // 2. If we have no data, or the data we got is stale (> 3 minutes), fetch
    //    live telemetry directly from the backend origin.
    if (!current || !isDataFresh(current)) {
        try {
            const [rc, rh, ri] = await fetchStatusFiles(backendOrigin);
            if (rc && (isDataFresh(rc) || !current)) {
                current = rc;
                history = rh;
                incidents = ri;
            }
        } catch {
            // Backend origin fetch failed; if we already have local data, proceed with it.
        }
    }

    // If still no data after all attempts, display the unavailable error state.
    if (!current) {
        const overall = document.querySelector('[data-overall]');
        overall.className = 'overall status-unknown';
        overall.querySelector('strong').textContent = 'Monitoring data unavailable';
        overall.querySelector('span').textContent = 'The status feed could not be loaded. Please try again shortly.';
        return;
    }

    const incidentIndex = indexActiveIncidents((incidents || {}).incidents);
    renderCurrent(current, history || {}, incidentIndex);
    renderHistory(history || {});
    renderIncidents(incidents || {});
}

load();
setInterval(load, 60000);

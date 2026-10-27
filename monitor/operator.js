/* What the operator states by hand, next to what the panel exports.

   PLANNED: maintenance announced ahead, shown in incidents.json (and the feed) by this Worker
   itself, so it is on the page before the panel goes down and while it is down. Before
   `starts_at` it is "scheduled"; from then "in_progress" (the components it names show
   maintenance); "resolved" once the panel, having answered 503 (maintenance) since the start,
   answers again, or when nothing happened 15 minutes after the start (it did not take place),
   or at `ends_at` at the latest.

   HARDWARE: each node's processor and memory, used when the panel's export does not name them
   (Pelican's never did; v3's does from Admin › Nodes). */

export const PLANNED = [
    {
        id: 'v3-2026-10-27',
        title: 'Moving plugged.host to v3',
        components: ['Panel'],
        announced_at: '2026-10-27T11:30:00Z',
        starts_at: '2026-10-27T16:52:00Z',
        ends_at: '2026-10-27T18:00:00Z',
        scheduled: 'The panel goes offline for about 10 minutes while we move plugged.host to v3. Game servers keep running; only the panel, SFTP and server starts pause.',
        started: 'Maintenance has started: the panel is offline while we move plugged.host to v3. Game servers keep running.',
        resolved: 'The maintenance is over and the panel is back.',
        skipped: 'This maintenance did not take place. A new date will be announced.',
    },
];

export const HARDWARE = {
    de1: { cpu_model: 'EPYC 7351P', memory_type: 'DDR4' },
    storage: { cpu_model: 'Xeon E5-2697 v4', memory_type: 'DDR4' },
    fr3: { cpu_model: '2× Xeon E5-2620 v3', memory_type: 'DDR4' },
    nl3: { cpu_model: 'Xeon E3-1240 v2', memory_type: 'DDR3' },
    nl4: { cpu_model: 'Xeon E3-1240 v2', memory_type: 'DDR3' },
    nl5: { cpu_model: 'EPYC 7232P', memory_type: 'DDR4' },
    pl1: { cpu_model: 'Ryzen 5 PRO 3600', memory_type: 'DDR4' },
    pl2: { cpu_model: '2× Xeon E5-2620', memory_type: 'DDR3' },
    pl3: { cpu_model: 'Xeon E3-1231 v3', memory_type: 'DDR3' },
    pl4: { cpu_model: 'Xeon E3-1231 v3', memory_type: 'DDR3' },
    pl5: { cpu_model: 'EPYC 7232P', memory_type: 'DDR4' },
};

const SKIP_AFTER_MS = 15 * 60 * 1000;

/* The planned items as incidents at `now`, given the panel probe; `memory` (kept in the
   Worker's state) remembers per item when the panel was first seen in maintenance and when it
   ended. */
export function plannedIncidents(now, panelProbe, memory) {
    const list = [];
    for (const item of PLANNED) {
        const start = Date.parse(item.starts_at);
        const end = Date.parse(item.ends_at);
        const seen = memory[item.id] ||= {};
        const updates = [{ status: 'scheduled', message: item.scheduled, published_at: item.announced_at }];
        let status = 'scheduled';
        let resolvedAt = null;

        if (now >= start) {
            if (panelProbe?.http === 503 && !seen.down) seen.down = now;
            if (!seen.ended) {
                if (seen.down && panelProbe?.reachable) seen.ended = now;
                else if (!seen.down && now >= start + SKIP_AFTER_MS) { seen.ended = now; seen.skipped = true; }
                else if (now >= end) seen.ended = now;
            }
            if (!seen.skipped) {
                updates.unshift({ status: 'in_progress', message: item.started, published_at: new Date(seen.down || start).toISOString() });
            }
            status = 'in_progress';
            if (seen.ended) {
                status = 'resolved';
                resolvedAt = new Date(seen.ended).toISOString();
                updates.unshift({ status: 'resolved', message: seen.skipped ? item.skipped : item.resolved, published_at: resolvedAt });
            }
        }

        list.push({
            id: item.id,
            title: item.title,
            impact: 'maintenance',
            status,
            components: item.components,
            started_at: item.starts_at,
            resolved_at: resolvedAt,
            updates,
        });
    }
    return list;
}

/* A node's processor and memory: the export's, else the operator's. */
export function hardwareOf(label, exported) {
    const known = HARDWARE[String(label || '').toLowerCase()] || {};
    return {
        cpu_model: exported?.cpu_model || known.cpu_model || null,
        memory_type: exported?.memory_type || known.memory_type || null,
    };
}

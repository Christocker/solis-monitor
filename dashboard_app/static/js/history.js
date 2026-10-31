/* ============================================================
   History page — fetch recorded readings (local API or Supabase via the
   deployment-specific common.js) and render charts + summary statistics.
   Data-driven: every available field is charted with its unit.
   ============================================================ */

const charts = {};
let lastRows = [];

// Chart colors come from the CSS design tokens so light/dark stay in sync.
function getChartColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fallback) => (cs.getPropertyValue(name) || fallback).trim() || fallback;
    return {
        solar: v("--solar", "#ff9500"),
        load: v("--load", "#af52de"),
        battery: v("--battery", "#34c759"),
        grid: v("--grid", "#0071e3"),
        teal: v("--teal", "#30b0c7"),
        text: v("--text-tertiary", "#6e6e73"),
        gridLine: v("--hairline", "rgba(0, 0, 0, 0.08)"),
        tooltipBg: v("--surface", "#ffffff"),
    };
}
let COLORS = getChartColors();

/* ---------------- Chart factory ---------------- */

function baseOptions(yTitle) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 700, easing: "easeOutQuart" },
        interaction: { mode: "nearest", intersect: false },
        plugins: {
            legend: { display: false },
            tooltip: {
                backgroundColor: COLORS.tooltipBg, titleColor: COLORS.text,
                bodyColor: COLORS.text, borderColor: COLORS.gridLine,
                borderWidth: 1, cornerRadius: 10, padding: 10,
                displayColors: false,
                callbacks: {
                    label: (ctx) => {
                        const v = ctx.parsed.y;
                        if (v == null) return "";
                        const def = CHART_DEFS.find((d) => d.id === ctx.chart.canvas.id);
                        const unit = def ? " " + def.unit : "";
                        return " " + v.toFixed(3) + unit;
                    },
                },
            },
        },
        scales: {
            x: { grid: { color: COLORS.gridLine },
                 ticks: { color: COLORS.text, maxTicksLimit: 8, font: { size: 11 } } },
            y: { title: { display: true, text: yTitle, color: COLORS.text, font: { size: 11 } },
                 grid: { color: COLORS.gridLine },
                 ticks: { color: COLORS.text, font: { size: 11 } }, beginAtZero: true },
        },
    };
}

function makeAreaChart(canvasId, color) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return null;
    const g = ctx.getContext("2d").createLinearGradient(0, 0, 0, 300);
    g.addColorStop(0, color + "55");
    g.addColorStop(1, color + "00");
    return new Chart(ctx, {
        type: "line",
        data: { labels: [], datasets: [] },
        options: { ...baseOptions(),
            elements: { line: { tension: 0.35, borderWidth: 2.5, borderColor: color,
                                fill: true, backgroundColor: g },
                        point: { radius: 0, hoverRadius: 4 } } },
    });
}

function makeLineChart(canvasId, color) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return null;
    return new Chart(ctx, {
        type: "line",
        data: { labels: [], datasets: [] },
        options: { ...baseOptions(),
            elements: { line: { tension: 0.35, borderWidth: 2.5, borderColor: color, fill: false },
                        point: { radius: 0, hoverRadius: 4 } } },
    });
}

function makeBarChart(canvasId, positiveColor, negativeColor) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return null;
    return new Chart(ctx, {
        type: "bar",
        data: { labels: [], datasets: [] },
        options: { ...baseOptions(),
            elements: { bar: { borderRadius: 3, borderSkipped: false,
                backgroundColor: (context) => {
                    const v = context.raw || 0;
                    return v >= 0 ? positiveColor + "cc" : negativeColor + "cc";
                } } } },
    });
}

/* ---------------- Chart definitions ----------------
   id       : canvas element id
   title    : chart card title
   col      : readings column
   unit     : display unit (also the y-axis title)
   type     : area | line | bar
   color    : accent color
   negColor : (bar only) color for negative values
   group    : 1=solar, 2=grid, 3=battery, 4=load (controls ordering)
---------------------------------------------------- */
const CHART_DEFS = [
    { id: "chart-pv", title: "PV Power", col: "pv_power", unit: "W",
      type: "area", color: "solar", group: 1 },
    { id: "chart-pv1-v", title: "PV1 Voltage", col: "pv1_voltage", unit: "V",
      type: "line", color: "solar", group: 1 },
    { id: "chart-pv1-a", title: "PV1 Current", col: "pv1_current", unit: "A",
      type: "line", color: "solar", group: 1 },
    { id: "chart-pv2-v", title: "PV2 Voltage", col: "pv2_voltage", unit: "V",
      type: "line", color: "solar", group: 1 },
    { id: "chart-pv2-a", title: "PV2 Current", col: "pv2_current", unit: "A",
      type: "line", color: "solar", group: 1 },

    { id: "chart-grid-v", title: "Grid Voltage", col: "grid_voltage", unit: "V",
      type: "line", color: "grid", group: 2 },
    { id: "chart-grid-f", title: "Grid Frequency", col: "grid_frequency", unit: "Hz",
      type: "line", color: "grid", group: 2 },

    { id: "chart-batt-v", title: "Battery Voltage", col: "battery_voltage", unit: "V",
      type: "line", color: "battery", group: 3 },
    { id: "chart-batt-a", title: "Battery Current", col: "battery_current", unit: "A",
      type: "line", color: "battery", group: 3 },
    { id: "chart-batt-w", title: "Battery Power", col: "battery_power", unit: "W",
      type: "line", color: "battery", group: 3 },
    { id: "chart-soc", title: "Battery SOC", col: "battery_soc", unit: "%",
      type: "line", color: "battery", group: 3 },
    { id: "chart-soh", title: "Battery SOH", col: "battery_soh", unit: "%",
      type: "line", color: "teal", group: 3 },

    { id: "chart-house-load", title: "House Load", col: "house_load", unit: "W",
      type: "area", color: "load", group: 4 },
    { id: "chart-backup-load", title: "Backup Load", col: "backup_load", unit: "W",
      type: "area", color: "load", group: 4 },
];

/* ---------------- Stat definitions ---------------- */
// Format a stat: numbers to 3 dp, but "—" when there is no data (never 0).
function fmt3(v) {
    return (v == null || isNaN(v)) ? NORMAL_DASH : Number(v).toFixed(3);
}

const STAT_DEFS = [
    { id: "stat-pv-kwh", label: "PV Generation", unit: "kWh", fn: (rows) => fmt3(sumEnergy(rows, "pv_power")) },
    { id: "stat-pv-avg", label: "Avg PV Power", unit: "W", fn: (rows) => fmt3(avgOf(rows, "pv_power")) },
    { id: "stat-pv-peak", label: "Peak PV Power", unit: "W", fn: (rows) => fmt3(maxOf(rows, "pv_power")) },
    { id: "stat-pv1-v-avg", label: "Avg PV1 Voltage", unit: "V", fn: (rows) => fmt3(avgOf(rows, "pv1_voltage")) },
    { id: "stat-pv2-v-avg", label: "Avg PV2 Voltage", unit: "V", fn: (rows) => fmt3(avgOf(rows, "pv2_voltage")) },

    { id: "stat-grid-v-avg", label: "Avg Grid Voltage", unit: "V", fn: (rows) => fmt3(avgOf(rows, "grid_voltage")) },
    { id: "stat-grid-f-avg", label: "Avg Grid Frequency", unit: "Hz", fn: (rows) => fmt3(avgOf(rows, "grid_frequency")) },
    { id: "stat-grid-time", label: "Grid Time", unit: "min", fn: (rows) => fmt3(gridMinutes(rows)) },

    { id: "stat-batt-v-avg", label: "Avg Battery Voltage", unit: "V", fn: (rows) => fmt3(avgOf(rows, "battery_voltage")) },
    { id: "stat-batt-a-avg", label: "Avg Battery Current", unit: "A", fn: (rows) => fmt3(avgOf(rows, "battery_current")) },
    { id: "stat-batt-w-avg", label: "Avg Battery Power", unit: "W", fn: (rows) => fmt3(avgOf(rows, "battery_power")) },
    { id: "stat-soc-avg", label: "Avg Battery SOC", unit: "%", fn: (rows) => fmt3(avgOf(rows, "battery_soc")) },
    { id: "stat-soh-avg", label: "Avg Battery SOH", unit: "%", fn: (rows) => fmt3(avgOf(rows, "battery_soh")) },

    { id: "stat-house-avg", label: "Avg House Load", unit: "W", fn: (rows) => fmt3(avgOf(rows, "house_load")) },
    { id: "stat-backup-avg", label: "Avg Backup Load", unit: "W", fn: (rows) => fmt3(avgOf(rows, "backup_load")) },
];

function makeOverviewChart() {
    const ctx = document.getElementById("chart-overview");
    if (!ctx) return null;
    const opts = baseOptions("Power (W)");
    opts.plugins.legend = { display: true,
        labels: { color: COLORS.text, boxWidth: 10, font: { size: 11 } } };
    opts.interaction = { mode: "index", intersect: false };
    opts.scales.y2 = {
        position: "right", beginAtZero: true, max: 100,
        grid: { drawOnChartArea: false },
        ticks: { color: COLORS.text, font: { size: 11 } },
        title: { display: true, text: "SOC (%)", color: COLORS.text, font: { size: 11 } },
    };
    const ds = (label, color, axis, extra) => Object.assign({
        label, data: [], borderColor: color, tension: 0.35, borderWidth: 2,
        pointRadius: 0, yAxisID: axis || "y",
    }, extra || {});
    return new Chart(ctx, {
        type: "line",
        data: { labels: [], datasets: [
            ds("PV Power", COLORS.solar, "y", { backgroundColor: COLORS.solar + "22", fill: true }),
            ds("Load", COLORS.load, "y"),
            ds("Battery", COLORS.battery, "y"),
            ds("SOC", COLORS.teal, "y2", { borderDash: [4, 4] }),
        ] },
        options: opts,
    });
}

function initCharts() {
    for (const def of CHART_DEFS) {
        const color = COLORS[def.color] || def.color;
        if (def.type === "area") charts[def.id] = makeAreaChart(def.id, color);
        else if (def.type === "bar") charts[def.id] = makeBarChart(def.id, color, COLORS.grid);
        else charts[def.id] = makeLineChart(def.id, color);
    }
    const ov = makeOverviewChart();
    if (ov) charts["chart-overview"] = ov;
    for (const id of Object.keys(charts)) enableChartPan(id);
}

/* ---------------- View handling ---------------- */
// Each view sets the time window and the aggregation bucket size.
let currentView = "minutes";
// End of the visible window. null = "live" (now); a value pins the window to
// a past moment so the Seconds/Minutes views can be explored backwards
// through the whole recording.
let anchorUnix = null;
// Free-form window set by dragging the timeline (or panning a chart):
// { start, end } in UNIX seconds. When null the preset view defines it.
let customWindow = null;
// Full recorded range { min, max }, loaded once from the history meta API.
let historyBounds = null;
// Windows ending this close to the newest sample count as "live" and follow
// new data automatically.
const LIVE_EDGE_SECONDS = 60;
// Never zoom in closer than one minute (the logger samples every ~2 s).
const TIMELINE_MIN_SPAN = 60;
// >0 while a window is being dragged (timeline or chart). Preview loads then
// animate instantly and must not snap the overlay back to a stale range.
let windowDragActive = 0;

function beginWindowDrag() { windowDragActive += 1; }
function endWindowDrag() { windowDragActive = Math.max(0, windowDragActive - 1); }

const VIEWS = {
    seconds: { label: "Seconds", window: 600,      points: 300, raw: true },     // 10 min @ 2s
    minutes: { label: "Minutes", window: 10800,    points: 360, buckets: 720 },  //  3 h
    hours:   { label: "Hours",   window: 604800,   points: 336, buckets: 672 },  //  7 d
    days:    { label: "Days",    window: 2592000,  points: 240, buckets: 720 },  // 30 d
    months:  { label: "Months",  window: 31536000, points: 365, buckets: 900 },  // 365 d
    all:     { label: "All",     window: null,     points: 300, buckets: 600 },  // first record -> now
};

// End time of the visible window (now when live, else the pinned anchor).
function windowEnd() {
    return anchorUnix == null ? Date.now() / 1000 : anchorUnix;
}

function viewRange(view) {
    if (customWindow) {
        // Live windows keep their length but follow the newest data.
        if (anchorUnix == null) {
            const span = customWindow.end - customWindow.start;
            const end = windowEnd();
            return { start: end - span, end: end };
        }
        return { start: customWindow.start, end: customWindow.end };
    }
    const w = VIEWS[view].window;
    if (w == null) return { start: null, end: null };   // full recorded range
    const end = windowEnd();
    let start = end - w;
    const b = timelineBounds();
    if (b && start < b.min) start = b.min;   // never ask before the first sample
    return { start: start, end: end };
}

// Length of a range in seconds, or null for the full recorded range.
function rangeSpan(rng) {
    return (rng.start == null || rng.end == null) ? null : rng.end - rng.start;
}

// True when the window is pinned to (or effectively at) the newest data.
function isLiveRange(rng) {
    if (anchorUnix != null) return false;
    if (rng.end == null) return true;
    const maxT = (historyBounds && historyBounds.max) || Date.now() / 1000;
    return rng.end >= maxT - LIVE_EDGE_SECONDS;
}

function timeLabel(ts, mode) {
    const d = new Date(ts * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    const hh = pad(d.getHours()), mm = pad(d.getMinutes()), ss = pad(d.getSeconds());
    switch (mode) {
        case "seconds": return hh + ":" + mm + ":" + ss;
        case "minutes": return hh + ":" + mm;
        case "hours": return (d.getMonth() + 1) + "/" + d.getDate() + " " + hh + ":00";
        case "months": return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
        case "all": return (d.getMonth() + 1) + "/" + d.getDate() + " " + hh + ":" + mm;
        default: return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    }
}

// Finest sensible label for a free-form span. Preset views keep their own
// label style; a dragged window picks whichever reads best at its length.
function labelModeForSpan(span, fallback) {
    if (span == null) return fallback;
    if (span <= 900) return "seconds";
    if (span <= 6 * 3600) return "minutes";
    if (span <= 8 * 86400) return "hours";
    if (span <= 90 * 86400) return "days";
    return "months";
}

function aggregate(rows, labelMode, points, col) {
    if (rows.length === 0) return { labels: [], data: [] };
    // Never create more buckets than there are rows, otherwise sparse ranges
    // render as (invisible) isolated points on an otherwise blank chart.
    const n = Math.min(points, rows.length);
    const first = rows[0].ts_unix;
    const last = rows[rows.length - 1].ts_unix;
    const span = Math.max(1, last - first);
    const bucket = span / n;
    const labels = [], data = [];
    for (let i = 0; i < n; i++) {
        const bStart = first + i * bucket;
        // The final bucket must include the newest row (bEnd == last).
        const bEnd = (i === n - 1) ? last + 1 : first + (i + 1) * bucket;
        let sum = 0, weight = 0;
        for (const r of rows) {
            if (r.ts_unix >= bStart && r.ts_unix < bEnd && r[col] != null) {
                const w = (r.samples != null) ? r.samples : 1;
                sum += r[col] * w;
                weight += w;
            }
        }
        labels.push(timeLabel(bStart, labelMode));
        data.push(weight ? sum / weight : null);
    }
    return { labels, data };
}

// Largest interval we trust when integrating power. Bucketed rows carry the
// server's bucket width; otherwise estimate the spacing from the series, or
// fall back to 300 s for raw rows. Anything longer spans missing data and
// must never fabricate energy.
function _energyMaxGap(rows) {
    if (rows.length && rows[0].bucket_width != null) {
        return rows[0].bucket_width * 1.5;
    }
    if (rows.length > 1 && rows[0].samples != null) {
        // Estimate bucket spacing robustly (median of consecutive gaps) and
        // treat anything beyond 1.5x as a data gap rather than real flow.
        const dts = [];
        for (let i = 1; i < rows.length; i++) dts.push(rows[i].ts_unix - rows[i - 1].ts_unix);
        dts.sort((a, b) => a - b);
        const median = dts[Math.floor(dts.length / 2)];
        return Math.max(1, median) * 1.5;
    }
    return 300;
}

function sumEnergy(rows, col) {
    if (rows.length < 2) return null;
    const maxGap = _energyMaxGap(rows);
    let kwh = 0;
    for (let i = 1; i < rows.length; i++) {
        const p1 = rows[i - 1][col], p2 = rows[i][col];
        if (p1 == null || p2 == null) continue;
        const dt = rows[i].ts_unix - rows[i - 1].ts_unix;
        if (!(dt > 0) || dt > maxGap) continue;
        kwh += ((p1 + p2) / 2) * dt / 3600 / 1000;
    }
    return kwh;
}

function maxOf(rows, col) {
    let m = null;
    for (const r of rows) {
        const v = (col === "pv_power" && r.pv_power_max != null) ? r.pv_power_max : r[col];
        if (v != null && (m === null || v > m)) m = v;
    }
    return m;
}

function avgOf(rows, col) {
    // Weighted average when rows are aggregated buckets (r.samples = raw count).
    let sum = 0, weight = 0;
    for (const r of rows) {
        if (r[col] == null) continue;
        const w = (r.samples != null) ? r.samples : 1;
        sum += r[col] * w;
        weight += w;
    }
    return weight ? sum / weight : null;
}

function gridMinutes(rows) {
    // Bucketed rows carry the grid-connected seconds for the bucket directly.
    if (rows.length && rows[0].grid_seconds != null) {
        let secs = 0;
        for (const r of rows) secs += (r.grid_seconds || 0);
        return Math.round(secs / 60);
    }
    if (rows.length < 2) return null;
    const maxGap = _energyMaxGap(rows);
    let secs = 0;
    for (let i = 1; i < rows.length; i++) {
        const dt = rows[i].ts_unix - rows[i - 1].ts_unix;
        const v1 = rows[i - 1].grid_voltage, v2 = rows[i].grid_voltage;
        if (dt > 0 && dt <= maxGap && v1 != null && v1 >= 50 && v2 != null && v2 >= 50)
            secs += dt;
    }
    return Math.round(secs / 60);
}

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

// Clear all charts and statistics (used when a range has no data, so stale
// values cannot be mistaken for the selected window).
function clearCharts() {
    for (const def of CHART_DEFS) {
        const chart = charts[def.id];
        if (!chart) continue;
        chart.data.labels = [];
        chart.data.datasets = [];
        chart.update();
    }
    for (const def of STAT_DEFS) setText(def.id, NORMAL_DASH);
    const ov = charts["chart-overview"];
    if (ov) {
        ov.data.labels = [];
        ov.data.datasets.forEach((d) => { d.data = []; });
        ov.update();
    }
}

function renderCharts(rows, labelMode, points) {
    // Summary stats
    for (const def of STAT_DEFS) {
        setText(def.id, def.fn(rows));
    }

    // Charts
    for (const def of CHART_DEFS) {
        const chart = charts[def.id];
        if (!chart) continue;
        const agg = aggregate(rows, labelMode, points, def.col);
        chart.data.labels = agg.labels;
        chart.data.datasets = [{ data: agg.data }];
        if (def.type === "line") {
            const col = COLORS[def.color] || def.color;
            chart.data.datasets[0].borderColor = col;
            chart.data.datasets[0].backgroundColor = col + "22";
        }
        chart.update(windowDragActive ? "none" : undefined);
    }

    const ov = charts["chart-overview"];
    if (ov) {
        const aPv = aggregate(rows, labelMode, points, "pv_power");
        const aLoad = aggregate(rows, labelMode, points, "load_power");
        const aBatt = aggregate(rows, labelMode, points, "battery_power");
        const aSoc = aggregate(rows, labelMode, points, "battery_soc");
        ov.data.labels = aPv.labels;
        ov.data.datasets[0].data = aPv.data;
        ov.data.datasets[1].data = aLoad.data;
        ov.data.datasets[2].data = aBatt.data;
        ov.data.datasets[3].data = aSoc.data;
        ov.update(windowDragActive ? "none" : undefined);
    }
}

let loadToken = 0;
let loadInFlight = false;
let loadQueued = false;
let previewTimer = null;
// Last range that was fetched, so a drag release right after a preview does
// not fetch the identical slice twice.
let lastLoad = { key: null, at: 0 };

// Reload shortly after the last change (dragging, editing the time field) so
// the charts follow the window without firing a request per pixel.
function schedulePreviewLoad(delay) {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
        previewTimer = null;
        loadHistory();
    }, delay == null ? 220 : delay);
}

async function loadHistory() {
    // Single-flight: coalesce bursts of window edits into one follow-up load
    // instead of stacking overlapping history queries.
    if (loadInFlight) { loadQueued = true; return; }
    loadInFlight = true;
    try {
        await loadHistoryNow();
    } finally {
        loadInFlight = false;
        if (loadQueued) {
            loadQueued = false;
            schedulePreviewLoad(60);
        }
    }
}

// How to query a window: raw samples for short spans (full resolution),
// server-side buckets for everything longer.
function planForRange(rng, view) {
    const span = rangeSpan(rng);
    if (span == null) return { raw: !!view.raw, limit: 10000, buckets: view.buckets };
    if (span <= 15 * 60) {
        const limit = Math.max(2000, Math.min(20000, Math.round(span / 1.5)));
        return { raw: true, limit: limit, buckets: view.buckets };
    }
    return { raw: false, limit: 10000, buckets: span >= 90 * 86400 ? 900 : 480 };
}

async function loadHistoryNow() {
    const token = ++loadToken;
    const viewKey = currentView;          // capture the view this load is for
    const view = VIEWS[viewKey];
    const statusEl = document.getElementById("history-status");
    const rng = viewRange(viewKey);
    const span = rangeSpan(rng);
    const plan = planForRange(rng, view);
    const points = view.points;
    const loadKey = [rng.start, rng.end, viewKey, plan.raw, plan.limit, plan.buckets].join("|");
    if (loadKey === lastLoad.key && Date.now() - lastLoad.at < 1500) return;
    statusEl.textContent = "Loading...";
    if (!windowDragActive) updateTimeNav(rng);
    const onProgress = plan.raw ? null : (done, total) => {
        if (token === loadToken) statusEl.textContent = "Loading " + done + "/" + total + "...";
    };
    try {
        const rows = plan.raw
            ? await fetchReadings(rng.start, rng.end, plan.limit)
            : await fetchHistoryBuckets(rng.start, rng.end, plan.buckets, onProgress);
        lastLoad = { key: loadKey, at: Date.now() };
        if (token !== loadToken) return;  // superseded by a newer request
        for (const r of rows) {
            r.load_power = (r.house_load == null && r.backup_load == null)
                ? null : (r.house_load || 0) + (r.backup_load || 0);
        }
        lastRows = rows;
        if (!rows || rows.length === 0) {
            clearCharts();
            statusEl.textContent = "No recorded data in this range yet.";
            return;
        }
        // Label density follows the data actually plotted (a requested window
        // can reach past the first sample, e.g. Months on a short archive).
        const dataSpan = rows.length > 1
            ? rows[rows.length - 1].ts_unix - rows[0].ts_unix : span;
        const labelMode = (viewKey === "all" && !customWindow)
            ? "all" : labelModeForSpan(dataSpan, "days");
        renderCharts(rows, labelMode, points);
        statusEl.textContent = rows.length + (plan.raw ? " samples" : " buckets");
    } catch (err) {
        if (token !== loadToken) return;
        clearCharts();
        if (err && err.rpcUnavailable) {
            statusEl.textContent =
                "Full history needs supabase/schema.sql (history_buckets)";
        } else {
            statusEl.textContent = "Error loading history";
        }
        console.error(err);
    }
}

// ---- URL state (bookmark / share) ----
function writeState() {
    try {
        const p = new URLSearchParams();
        p.set("view", currentView);
        if (customWindow) {
            p.set("s", String(Math.round(customWindow.start)));
            p.set("e", String(Math.round(customWindow.end)));
        } else if (anchorUnix != null) {
            p.set("t", String(Math.round(anchorUnix)));
        }
        history.replaceState(null, "", location.pathname + "?" + p.toString());
    } catch (e) { /* ignore */ }
}

function readStateFromURL() {
    try {
        const p = new URLSearchParams(location.search);
        const view = p.get("view");
        if (view && VIEWS[view]) currentView = view;
        anchorUnix = null;
        customWindow = null;
        const t = Number(p.get("t"));
        anchorUnix = (p.get("t") && !isNaN(t) && t < Date.now() / 1000) ? t : null;
        const s = Number(p.get("s")), e = Number(p.get("e"));
        if (p.get("s") && p.get("e") && isFinite(s) && isFinite(e) && e > s) {
            customWindow = { start: s, end: e };
            anchorUnix = e < Date.now() / 1000 - LIVE_EDGE_SECONDS ? e : null;
        }
    } catch (e) { /* ignore */ }
}

// Which preset button matches this span (null = free-form window).
function matchPreset(span) {
    if (span == null) return "all";
    let best = null, bestDiff = Infinity;
    for (const key of Object.keys(VIEWS)) {
        const w = VIEWS[key].window;
        if (w == null) continue;
        const diff = Math.abs(w - span) / w;
        if (diff < bestDiff) { bestDiff = diff; best = key; }
    }
    return bestDiff <= 0.02 ? best : null;
}

function syncViewButtons() {
    const active = customWindow ? matchPreset(rangeSpan(customWindow)) : currentView;
    document.querySelectorAll(".range-btn").forEach((b) => {
        const on = b.dataset.range === active;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
    });
}

function setupShare() {
    const bar = document.querySelector(".time-nav");
    if (!bar || document.getElementById("share-btn")) return;
    const btn = document.createElement("button");
    btn.id = "share-btn";
    btn.className = "nav-btn latest";
    btn.type = "button";
    btn.textContent = "Share";
    btn.title = "Copy a link to this view";
    btn.addEventListener("click", async () => {
        const url = location.href;
        try {
            if (navigator.share) { await navigator.share({ title: document.title, url }); return; }
        } catch (e) { /* cancelled or unsupported */ }
        try {
            await navigator.clipboard.writeText(url);
            btn.textContent = "Copied!";
            setTimeout(() => { btn.textContent = "Share"; }, 1500);
        } catch (e) {
            window.prompt("Copy this link:", url);
        }
    });
    bar.appendChild(btn);
}

function setupExport() {
    const bar = document.querySelector(".time-nav");
    if (!bar || document.getElementById("export-btn")) return;
    const btn = document.createElement("button");
    btn.id = "export-btn";
    btn.className = "nav-btn latest";
    btn.type = "button";
    btn.textContent = "CSV";
    btn.title = "Download the current range as CSV";
    btn.addEventListener("click", exportCSV);
    bar.appendChild(btn);
}

function exportCSV() {
    if (!lastRows || lastRows.length === 0) return;
    const cols = ["pv1_voltage", "pv1_current", "pv2_voltage", "pv2_current",
                  "pv_power", "grid_voltage", "grid_frequency",
                  "battery_voltage", "battery_current", "battery_power",
                  "battery_soc", "battery_soh", "house_load", "backup_load"];
    const lines = ["ts_unix,ts_iso," + cols.join(",") + ",load_power,samples"];
    for (const r of lastRows) {
        const iso = r.ts_iso || r.ts ||
            new Date((r.ts_unix || 0) * 1000).toISOString().replace("T", " ").slice(0, 19);
        const load = (r.house_load == null && r.backup_load == null) ? ""
            : ((r.house_load || 0) + (r.backup_load || 0));
        const vals = cols.map((c) => (r[c] == null ? "" : r[c]));
        lines.push([r.ts_unix, '"' + iso + '"', ...vals, load,
                    r.samples == null ? "" : r.samples].join(","));
    }
    const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "solis-history-" + currentView + "-" +
        new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function setupViewButtons() {
    document.querySelectorAll(".range-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            currentView = btn.dataset.range;
            customWindow = null;             // preset buttons define the window
            anchorUnix = null;               // ...and always start live
            syncViewButtons();
            writeState();
            updateTimeNav();
            loadHistory();
        });
    });
    syncViewButtons();
}

// ---- Time navigation (explore the past at any resolution) ----
function pad2(n) { return String(n).padStart(2, "0"); }

function toLocalInput(ts) {
    const d = new Date(ts * 1000);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate())
        + "T" + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

// Full recorded range, or null until it has loaded.
function timelineBounds() {
    if (historyBounds && historyBounds.min != null && historyBounds.max != null &&
        historyBounds.max > historyBounds.min) {
        return historyBounds;
    }
    return null;
}

// Clamp a window to the recording, keep it at least a minute long, and make it
// the visible range. With commit:false it is only previewed (used mid-drag).
function applyWindow(start, end, opts) {
    const b = timelineBounds();
    const maxT = b ? b.max : Date.now() / 1000;
    const floor = b ? b.min : -Infinity;
    let s = start, e = end;
    if (!(e > s)) e = s + TIMELINE_MIN_SPAN;
    if (e - s < TIMELINE_MIN_SPAN) e = s + TIMELINE_MIN_SPAN;

    const span = e - s;
    if (b && span >= b.max - b.min) {
        s = b.min; e = b.max;                // the whole recording
    } else {
        if (s < floor) { s = floor; e = s + span; }
        if (e > maxT) { e = maxT; s = Math.max(floor, e - span); }
    }

    customWindow = { start: s, end: e };
    anchorUnix = (e >= maxT - LIVE_EDGE_SECONDS) ? null : e;
    if (opts && opts.commit === false) return;
    syncViewButtons();
    writeState();
    updateTimeNav();
    loadHistory();
}

function shiftWindow(dir) {
    const r = viewRange(currentView);
    const span = rangeSpan(r);
    if (span == null) return;                // "All" has no fixed window
    applyWindow(r.start + dir * span, r.end + dir * span);
}

// Move the window so it ends at `t`, keeping its current length.
function setWindowEnd(t, defer) {
    const span = rangeSpan(viewRange(currentView)) || VIEWS.minutes.window;
    applyWindow(t - span, t, { commit: false });
    updateTimeNav();
    syncViewButtons();
    writeState();
    if (defer) schedulePreviewLoad(300);
    else loadHistory();
}

// Parse the datetime-local field; ignore partial/out-of-range values while the
// user is still typing so the charts never jump to year 0002.
function parseInputTime(value) {
    if (!value || value.length < 16) return null;
    const t = Math.floor(new Date(value).getTime() / 1000);
    if (isNaN(t)) return null;
    const b = timelineBounds();
    if (t > Date.now() / 1000 + 86400) return null;
    if (b && t < b.min - 86400) return null;
    return t;
}

function setupTimeNav() {
    const prev = document.getElementById("nav-prev");
    const next = document.getElementById("nav-next");
    const nowBtn = document.getElementById("nav-now");
    const input = document.getElementById("nav-time");
    if (prev) prev.addEventListener("click", () => shiftWindow(-1));
    if (next) next.addEventListener("click", () => shiftWindow(1));
    if (nowBtn) nowBtn.addEventListener("click", () => {
        if (customWindow) {                  // keep the dragged length, go live
            const span = customWindow.end - customWindow.start;
            const end = Date.now() / 1000;
            customWindow = { start: end - span, end };
        }
        anchorUnix = null;
        syncViewButtons();
        writeState();
        updateTimeNav();
        loadHistory();
    });
    if (input) {
        const commit = () => {
            const t = parseInputTime(input.value);
            if (t != null) setWindowEnd(t, false);
        };
        input.addEventListener("change", commit);
        // Date/time pickers fire `input` for each segment change: follow the
        // field live (debounced) instead of waiting for Enter/blur.
        input.addEventListener("input", () => {
            const t = parseInputTime(input.value);
            if (t != null) setWindowEnd(t, true);
        });
    }
    updateTimeNav();
}

function updateTimeNav(rng) {
    const input = document.getElementById("nav-time");
    const prev = document.getElementById("nav-prev");
    const next = document.getElementById("nav-next");
    const nowBtn = document.getElementById("nav-now");
    const label = document.getElementById("nav-label");
    const r = rng || viewRange(currentView);
    const span = rangeSpan(r);
    const live = isLiveRange(r);
    const b = timelineBounds();

    if (input && document.activeElement !== input) {
        input.value = toLocalInput(live ? Date.now() / 1000 : r.end);
    }
    if (prev) prev.disabled = r.start == null || (b != null && r.start <= b.min + 1);
    if (next) next.disabled = r.end == null || live;
    if (nowBtn) {
        nowBtn.classList.toggle("active", live);
        nowBtn.setAttribute("aria-pressed", live ? "true" : "false");
    }
    if (label) {
        if (span == null) {
            label.textContent = "All recorded data";
        } else {
            const fmt = (ts) => new Date(ts * 1000).toLocaleString();
            label.textContent = fmt(r.start) + "  →  " + fmt(r.end) + (live ? "  (live)" : "");
        }
    }
    renderTimeline(r);
}

/* ---------------- Draggable timeline ----------------
   A miniature ruler of the whole recording. Drag the highlighted window to
   move it through time; drag either edge to zoom in or out. Clicking the
   ruler jumps the window to that point.
-------------------------------------------------------- */
function fmtTimelineTick(ts, span) {
    const d = new Date(ts * 1000);
    if (span <= 2 * 86400) {
        return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    }
    if (span <= 120 * 86400) {
        return (d.getMonth() + 1) + "/" + d.getDate();
    }
    return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
}

function fmtWindowShort(start, end) {
    const d1 = new Date(start * 1000), d2 = new Date(end * 1000);
    const date = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const time = (d) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    if (end - start > 36 * 3600) return date(d1) + " – " + date(d2);
    if (d1.toDateString() === d2.toDateString()) {
        return date(d1) + " " + time(d1) + " – " + time(d2);
    }
    return date(d1) + " " + time(d1) + " – " + date(d2) + " " + time(d2);
}

function renderTimelineScale(b) {
    const el = document.getElementById("timeline-scale");
    if (!el) return;
    const span = b.max - b.min;
    const n = window.matchMedia("(max-width: 640px)").matches ? 3 : 5;
    el.textContent = "";
    for (let i = 0; i < n; i++) {
        const tick = document.createElement("span");
        tick.textContent = fmtTimelineTick(b.min + span * (i / (n - 1)), span);
        el.appendChild(tick);
    }
}

function renderTimeline(rng) {
    const track = document.getElementById("timeline-track");
    const win = document.getElementById("timeline-window");
    if (!track || !win) return;
    const b = timelineBounds();
    track.classList.toggle("is-disabled", !b);
    if (!b) {
        win.style.left = "0%";
        win.style.width = "100%";
        return;
    }
    renderTimelineScale(b);

    const r = rng || viewRange(currentView);
    const total = b.max - b.min;
    // A live window can reach past the newest sample; clip it to the track.
    let start = r.start == null ? b.min : Math.max(b.min, r.start);
    let end = r.end == null ? b.max : Math.min(b.max, r.end);
    if (!(end > start)) { start = b.min; end = b.max; }

    const leftPct = ((start - b.min) / total) * 100;
    const widthPct = Math.max(0.8, ((end - start) / total) * 100);
    const left = Math.min(99.2, Math.max(0, leftPct));
    win.style.left = left + "%";
    win.style.width = Math.min(100 - left, widthPct) + "%";
    win.classList.toggle("is-full", widthPct >= 99);

    const label = document.getElementById("timeline-window-label");
    if (label) {
        const allView = !customWindow && VIEWS[currentView].window == null;
        label.textContent = allView ? "All recorded data" : fmtWindowShort(start, end);
    }
    // A 15-minute window on a 42-day ruler is a sliver: thin the grips and drop
    // the label so it stays clickable instead of becoming a blue blob.
    win.classList.toggle("is-tiny", (widthPct / 100) * track.clientWidth < 44);
    win.setAttribute("aria-valuemin", String(Math.round(b.min)));
    win.setAttribute("aria-valuemax", String(Math.round(b.max)));
    win.setAttribute("aria-valuenow", String(Math.round(start)));
    win.setAttribute("aria-valuetext", fmtWindowShort(start, end));
}

let tlDrag = null;

function timelinePointerDown(e) {
    const track = document.getElementById("timeline-track");
    const b = timelineBounds();
    if (!track || !b || (e.button != null && e.button > 0)) return;
    const r = viewRange(currentView);
    let start = r.start == null ? b.min : Math.max(b.min, r.start);
    let end = r.end == null ? b.max : Math.min(b.max, r.end);
    const grip = e.target.closest ? e.target.closest(".timeline-grip") : null;
    let mode = "pan";
    let jumped = false;
    if (grip) {
        mode = grip.dataset.edge === "start" ? "resize-start" : "resize-end";
    } else if (!e.target.closest(".timeline-window")) {
        // Click on the ruler: centre the window on that instant.
        const rect = track.getBoundingClientRect();
        const t = b.min + ((e.clientX - rect.left) / Math.max(1, rect.width)) * (b.max - b.min);
        const span = end - start;
        start = t - span / 2;
        end = t + span / 2;
        if (start < b.min) { start = b.min; end = start + span; }
        if (end > b.max) { end = b.max; start = end - span; }
        applyWindow(start, end, { commit: false });
        updateTimeNav();
        jumped = true;
    }
    tlDrag = { mode: mode, x: e.clientX, start: start, end: end, moved: false, jumped: jumped };
    try { track.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    track.classList.add("dragging");
    beginWindowDrag();
    e.preventDefault();
}

function timelinePointerMove(e) {
    if (!tlDrag) return;
    const track = document.getElementById("timeline-track");
    const b = timelineBounds();
    if (!track || !b) return;
    const secPerPx = (b.max - b.min) / Math.max(1, track.clientWidth);
    const dx = (e.clientX - tlDrag.x) * secPerPx;
    let s = tlDrag.start, en = tlDrag.end;
    if (tlDrag.mode === "pan") {
        s += dx; en += dx;
        const span = en - s;
        if (s < b.min) { s = b.min; en = s + span; }
        if (en > b.max) { en = b.max; s = en - span; }
    } else if (tlDrag.mode === "resize-start") {
        s = Math.max(b.min, Math.min(en - TIMELINE_MIN_SPAN, s + dx));
    } else {
        en = Math.min(b.max, Math.max(s + TIMELINE_MIN_SPAN, en + dx));
    }
    tlDrag.moved = tlDrag.moved || Math.abs(dx) > 0;
    applyWindow(s, en, { commit: false });
    updateTimeNav();
    schedulePreviewLoad();
    e.preventDefault();
}

function timelinePointerUp(e) {
    if (!tlDrag) return;
    const track = document.getElementById("timeline-track");
    const committed = tlDrag.moved || tlDrag.jumped;
    tlDrag = null;
    if (track) {
        track.classList.remove("dragging");
        try { track.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }
    endWindowDrag();
    if (committed && customWindow) applyWindow(customWindow.start, customWindow.end);
}

// Left/Right pan the window; +/- zoom around its centre.
function timelineKeyDown(e) {
    const r = viewRange(currentView);
    const span = rangeSpan(r);
    if (span == null) return;
    const step = span * (e.shiftKey ? 0.5 : 0.1);
    const mid = (r.start + r.end) / 2;
    switch (e.key) {
        case "ArrowLeft": applyWindow(r.start - step, r.end - step); break;
        case "ArrowRight": applyWindow(r.start + step, r.end + step); break;
        case "+": case "=": {
            const half = Math.max(TIMELINE_MIN_SPAN / 2, span / 4);
            applyWindow(mid - half, mid + half);
            break;
        }
        case "-": case "_":
            applyWindow(mid - span, mid + span);
            break;
        default: return;
    }
    e.preventDefault();
}

// Pan every chart horizontally by dragging it (touch: vertical scroll still works).
function enableChartPan(canvasId) {
    const cv = document.getElementById(canvasId);
    if (!cv || cv.dataset.panBound === "1") return;
    cv.dataset.panBound = "1";
    let drag = null;
    cv.style.touchAction = "pan-y";
    cv.addEventListener("pointerdown", (e) => {
        if (e.button > 0) return;
        const r = viewRange(currentView);
        if (r.start == null || r.end == null) return;      // "All" has no window
        drag = { x: e.clientX, start: r.start, end: r.end, moved: false };
        try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        beginWindowDrag();
    });
    cv.addEventListener("pointermove", (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.x;
        if (!drag.moved && Math.abs(dx) < 6) return;        // a tap, not a drag
        drag.moved = true;
        cv.classList.add("panning");
        const span = drag.end - drag.start;
        const dt = -(dx / Math.max(1, cv.clientWidth)) * span;
        applyWindow(drag.start + dt, drag.end + dt, { commit: false });
        updateTimeNav();
        schedulePreviewLoad();
        e.preventDefault();
    });
    const finish = (e) => {
        if (!drag) return;
        const moved = drag.moved;
        drag = null;
        cv.classList.remove("panning");
        try { cv.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        endWindowDrag();
        if (moved && customWindow) applyWindow(customWindow.start, customWindow.end);
    };
    cv.addEventListener("pointerup", finish);
    cv.addEventListener("pointercancel", finish);
}

async function loadBounds() {
    if (typeof fetchHistoryBounds !== "function") return;
    try {
        // Never block the first chart load on a slow meta request.
        const b = await Promise.race([
            fetchHistoryBounds(),
            new Promise((resolve) => setTimeout(() => resolve(null), 2500)),
        ]);
        if (!b || b.min == null || b.max == null || !(b.max > b.min)) return;
        historyBounds = { min: b.min, max: b.max };
        // Now that the newest sample is known, a window parked at the end can
        // follow new data again.
        if (anchorUnix != null && anchorUnix >= b.max - LIVE_EDGE_SECONDS &&
                Date.now() / 1000 - anchorUnix < 300) {
            anchorUnix = null;
        }
    } catch (e) { /* timeline stays disabled; history itself still works */ }
    updateTimeNav();
}

let timelineReady = null;

function setupTimeline() {
    const track = document.getElementById("timeline-track");
    if (!track) return;
    track.addEventListener("pointerdown", timelinePointerDown);
    track.addEventListener("pointermove", timelinePointerMove);
    track.addEventListener("pointerup", timelinePointerUp);
    track.addEventListener("pointercancel", timelinePointerUp);
    const win = document.getElementById("timeline-window");
    if (win) win.addEventListener("keydown", timelineKeyDown);
    window.addEventListener("resize", () => {
        const b = timelineBounds();
        if (b) renderTimelineScale(b);
        renderTimeline();
    });
    timelineReady = loadBounds();
}

// Rebuild charts with the new palette when the theme changes.
window.addEventListener("themechange", () => {
    COLORS = getChartColors();
    for (const k of Object.keys(charts)) {
        if (charts[k]) charts[k].destroy();
        delete charts[k];
    }
    initCharts();
    loadHistory();
});

window.addEventListener("popstate", () => {
    readStateFromURL();
    syncViewButtons();
    updateTimeNav();
    loadHistory();
});

document.addEventListener("DOMContentLoaded", async () => {
    readStateFromURL();
    initCharts();
    setupViewButtons();
    setupTimeNav();
    setupTimeline();
    setupShare();
    setupExport();
    renderTimeline();
    // Wait (briefly) for the archive bounds so the first query is clipped to
    // real data — otherwise "Months" would scan empty time before the start.
    if (timelineReady) await timelineReady;
    updateTimeNav();
    writeState();
    loadHistory();
    // Auto-refresh only live, cheap ranges. A pinned window is static, and a
    // multi-day live window does not gain detail every 30 s.
    setInterval(() => {
        if (anchorUnix != null) return;
        const span = rangeSpan(viewRange(currentView));
        const cheapView = currentView === "seconds" || currentView === "minutes";
        if (cheapView || (span != null && span <= 86400)) loadHistory();
    }, 30000);
});

/* ============================================================
   History page (web) — fetch readings from Supabase, render charts.
   Data-driven: every available field is charted with its unit.
   ============================================================ */

const charts = {};
const COLORS = {
    solar: "#ff9f0a",
    load: "#bf5af2",
    battery: "#30d158",
    grid: "#0a84ff",
    teal: "#64d2ff",
    text: "#98989d",
    gridLine: "rgba(84, 84, 88, 0.25)",
    tooltipBg: "rgba(28, 28, 30, 0.95)",
};

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
                backgroundColor: COLORS.tooltipBg, titleColor: "#fff",
                bodyColor: "#e6e6e6", borderColor: "rgba(84,84,88,0.6)",
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
      type: "area", color: COLORS.solar, group: 1 },
    { id: "chart-pv1-v", title: "PV1 Voltage", col: "pv1_voltage", unit: "V",
      type: "line", color: COLORS.solar, group: 1 },
    { id: "chart-pv1-a", title: "PV1 Current", col: "pv1_current", unit: "A",
      type: "line", color: COLORS.solar, group: 1 },
    { id: "chart-pv2-v", title: "PV2 Voltage", col: "pv2_voltage", unit: "V",
      type: "line", color: COLORS.solar, group: 1 },
    { id: "chart-pv2-a", title: "PV2 Current", col: "pv2_current", unit: "A",
      type: "line", color: COLORS.solar, group: 1 },

    { id: "chart-grid-v", title: "Grid Voltage", col: "grid_voltage", unit: "V",
      type: "line", color: COLORS.grid, group: 2 },
    { id: "chart-grid-f", title: "Grid Frequency", col: "grid_frequency", unit: "Hz",
      type: "line", color: COLORS.grid, group: 2 },

    { id: "chart-batt-v", title: "Battery Voltage", col: "battery_voltage", unit: "V",
      type: "line", color: COLORS.battery, group: 3 },
    { id: "chart-batt-a", title: "Battery Current", col: "battery_current", unit: "A",
      type: "line", color: COLORS.battery, group: 3 },
    { id: "chart-batt-w", title: "Battery Power", col: "battery_power", unit: "W",
      type: "line", color: COLORS.battery, group: 3 },
    { id: "chart-soc", title: "Battery SOC", col: "battery_soc", unit: "%",
      type: "line", color: COLORS.battery, group: 3 },
    { id: "chart-soh", title: "Battery SOH", col: "battery_soh", unit: "%",
      type: "line", color: COLORS.teal, group: 3 },

    { id: "chart-house-load", title: "House Load", col: "house_load", unit: "W",
      type: "area", color: COLORS.load, group: 4 },
    { id: "chart-backup-load", title: "Backup Load", col: "backup_load", unit: "W",
      type: "area", color: COLORS.load, group: 4 },
];

/* ---------------- Stat definitions ---------------- */
const STAT_DEFS = [
    { id: "stat-pv-kwh", label: "PV Generation", unit: "kWh", fn: (rows) => sumEnergy(rows, "pv_power").toFixed(3) },
    { id: "stat-pv-avg", label: "Avg PV Power", unit: "W", fn: (rows) => avgOf(rows, "pv_power").toFixed(3) },
    { id: "stat-pv-peak", label: "Peak PV Power", unit: "W", fn: (rows) => maxOf(rows, "pv_power").toFixed(3) },
    { id: "stat-pv1-v-avg", label: "Avg PV1 Voltage", unit: "V", fn: (rows) => avgOf(rows, "pv1_voltage").toFixed(3) },
    { id: "stat-pv2-v-avg", label: "Avg PV2 Voltage", unit: "V", fn: (rows) => avgOf(rows, "pv2_voltage").toFixed(3) },

    { id: "stat-grid-v-avg", label: "Avg Grid Voltage", unit: "V", fn: (rows) => avgOf(rows, "grid_voltage").toFixed(3) },
    { id: "stat-grid-f-avg", label: "Avg Grid Frequency", unit: "Hz", fn: (rows) => avgOf(rows, "grid_frequency").toFixed(3) },
    { id: "stat-grid-time", label: "Grid Time", unit: "min", fn: (rows) => gridMinutes(rows).toFixed(3) },

    { id: "stat-batt-v-avg", label: "Avg Battery Voltage", unit: "V", fn: (rows) => avgOf(rows, "battery_voltage").toFixed(3) },
    { id: "stat-batt-a-avg", label: "Avg Battery Current", unit: "A", fn: (rows) => avgOf(rows, "battery_current").toFixed(3) },
    { id: "stat-batt-w-avg", label: "Avg Battery Power", unit: "W", fn: (rows) => avgOf(rows, "battery_power").toFixed(3) },
    { id: "stat-soc-avg", label: "Avg Battery SOC", unit: "%", fn: (rows) => avgOf(rows, "battery_soc").toFixed(3) },
    { id: "stat-soh-avg", label: "Avg Battery SOH", unit: "%", fn: (rows) => avgOf(rows, "battery_soh").toFixed(3) },

    { id: "stat-house-avg", label: "Avg House Load", unit: "W", fn: (rows) => avgOf(rows, "house_load").toFixed(3) },
    { id: "stat-backup-avg", label: "Avg Backup Load", unit: "W", fn: (rows) => avgOf(rows, "backup_load").toFixed(3) },
];

function initCharts() {
    for (const def of CHART_DEFS) {
        if (def.type === "area") charts[def.id] = makeAreaChart(def.id, def.color);
        else if (def.type === "bar") charts[def.id] = makeBarChart(def.id, def.color, def.negColor || COLORS.grid);
        else charts[def.id] = makeLineChart(def.id, def.color);
    }
}

/* ---------------- Range handling ---------------- */
let currentRange = "today";

function dayRange(offsetDays) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - offsetDays);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    end.setMilliseconds(-1);
    return { start: start.getTime() / 1000, end: end.getTime() / 1000 };
}

function rangeToUnix(range) {
    const now = Date.now() / 1000;
    switch (range) {
        case "today": return dayRange(0);
        case "yesterday": return dayRange(1);
        case "7d": return { start: now - 7 * 86400, end: now };
        case "30d": return { start: now - 30 * 86400, end: now };
        case "all": return null;
        default: return { start: now - 86400, end: now };
    }
}

function timeLabel(ts, range) {
    const d = new Date(ts * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    const hhmm = pad(d.getHours()) + ":" + pad(d.getMinutes());
    if (range === "today" || range === "yesterday") return hhmm;
    if (range === "7d") return (d.getMonth() + 1) + "/" + d.getDate() + " " + pad(d.getHours()) + ":00";
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

function aggregate(rows, range, points, col) {
    if (rows.length === 0) return { labels: [], data: [] };
    const first = rows[0].ts_unix;
    const last = rows[rows.length - 1].ts_unix;
    const span = Math.max(1, last - first);
    const bucket = span / points;
    const labels = [], data = [];
    for (let i = 0; i < points; i++) {
        const bStart = first + i * bucket, bEnd = first + (i + 1) * bucket;
        let sum = 0, count = 0;
        for (const r of rows) {
            if (r.ts_unix >= bStart && r.ts_unix < bEnd && r[col] != null) {
                sum += r[col]; count++;
            }
        }
        labels.push(timeLabel(bStart, range));
        data.push(count ? sum / count : null);
    }
    return { labels, data };
}

function sumEnergy(rows, col) {
    if (rows.length < 2) return 0;
    let kwh = 0;
    for (let i = 1; i < rows.length; i++) {
        const p1 = rows[i - 1][col], p2 = rows[i][col];
        if (p1 == null || p2 == null) continue;
        const dt = rows[i].ts_unix - rows[i - 1].ts_unix;
        kwh += ((p1 + p2) / 2) * dt / 3600 / 1000;
    }
    return kwh;
}

function maxOf(rows, col) {
    let m = 0;
    for (const r of rows) if (r[col] != null && r[col] > m) m = r[col];
    return m;
}

function avgOf(rows, col) {
    let sum = 0, count = 0;
    for (const r of rows) if (r[col] != null) { sum += r[col]; count++; }
    return count ? sum / count : 0;
}

function gridMinutes(rows) {
    let secs = 0;
    for (let i = 1; i < rows.length; i++) {
        const v1 = rows[i - 1].grid_voltage, v2 = rows[i].grid_voltage;
        if (v1 != null && v1 >= 50 && v2 != null && v2 >= 50)
            secs += rows[i].ts_unix - rows[i - 1].ts_unix;
    }
    return Math.round(secs / 60);
}

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function renderCharts(rows, range) {
    const points = (range === "today" || range === "yesterday") ? 48 : 120;

    // Summary stats
    for (const def of STAT_DEFS) {
        setText(def.id, def.fn(rows));
    }

    // Charts
    for (const def of CHART_DEFS) {
        const chart = charts[def.id];
        if (!chart) continue;
        const agg = aggregate(rows, range, points, def.col);
        chart.data.labels = agg.labels;
        chart.data.datasets = [{ data: agg.data }];
        if (def.type === "line") {
            chart.data.datasets[0].borderColor = def.color;
            chart.data.datasets[0].backgroundColor = def.color + "22";
        }
        chart.update();
    }
}

async function loadHistory() {
    const statusEl = document.getElementById("history-status");
    statusEl.textContent = "Loading...";
    const rng = rangeToUnix(currentRange);
    try {
        const rows = await fetchReadings(rng ? rng.start : null, rng ? rng.end : null, 10000);
        if (!rows || rows.length === 0) {
            statusEl.textContent = "No recorded data in this range yet.";
            return;
        }
        renderCharts(rows, currentRange);
        statusEl.textContent = rows.length + " samples";
    } catch (err) {
        statusEl.textContent = "Error loading history";
        console.error(err);
    }
}

function setupRangeButtons() {
    document.querySelectorAll(".range-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".range-btn").forEach((b) => b.classList.remove("active"));
            btn.classList.add("active");
            currentRange = btn.dataset.range;
            loadHistory();
        });
    });
}

document.addEventListener("DOMContentLoaded", () => {
    initCharts();
    setupRangeButtons();
    loadHistory();
    setInterval(loadHistory, 30000);
});

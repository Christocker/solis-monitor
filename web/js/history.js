/* ============================================================
   History page (web) — fetch readings from Supabase, render charts.
   ============================================================ */

const charts = {};
const COLORS = {
    solar: "#ff9f0a",
    load: "#bf5af2",
    battery: "#30d158",
    grid: "#0a84ff",
    text: "#98989d",
    gridLine: "rgba(84, 84, 88, 0.25)",
    tooltipBg: "rgba(28, 28, 30, 0.95)",
};

function baseOptions(yTitle) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 800, easing: "easeOutQuart" },
        interaction: { mode: "nearest", intersect: false },
        plugins: {
            legend: { display: false },
            tooltip: {
                backgroundColor: COLORS.tooltipBg, titleColor: "#fff",
                bodyColor: "#e6e6e6", borderColor: "rgba(84,84,88,0.6)",
                borderWidth: 1, cornerRadius: 10, padding: 10,
                displayColors: false,
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

function initCharts() {
    charts.pv = makeAreaChart("chart-pv", COLORS.solar);
    charts.load = makeAreaChart("chart-load", COLORS.load);
    charts.soc = makeLineChart("chart-soc", COLORS.battery);
    charts.batt = makeBarChart("chart-batt-power", COLORS.battery, COLORS.grid);
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
    const pv = aggregate(rows, range, points, "pv_power");
    const load = aggregate(rows, range, points, "load_power");
    const soc = aggregate(rows, range, points, "battery_soc");
    const batt = aggregate(rows, range, points, "battery_power");

    charts.pv.data.labels = pv.labels;
    charts.pv.data.datasets = [{ data: pv.data }];
    charts.pv.update();

    charts.load.data.labels = load.labels;
    charts.load.data.datasets = [{ data: load.data }];
    charts.load.update();

    charts.soc.data.labels = soc.labels;
    charts.soc.data.datasets = [{ data: soc.data, borderColor: COLORS.battery,
                                  backgroundColor: COLORS.battery + "22" }];
    charts.soc.update();

    charts.batt.data.labels = batt.labels;
    charts.batt.data.datasets = [{ data: batt.data }];
    charts.batt.update();

    setText("stat-pv-kwh", sumEnergy(rows, "pv_power").toFixed(2));
    setText("stat-pv-avg", Math.round(avgOf(rows, "pv_power")));
    setText("stat-pv-peak", Math.round(maxOf(rows, "pv_power")));
    setText("stat-grid-time", gridMinutes(rows));
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
        for (const r of rows) {
            r.load_power = (r.house_load != null && r.house_load > 0)
                ? r.house_load : r.backup_load;
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
});

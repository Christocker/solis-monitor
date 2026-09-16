/* ============================================================
   System & Diagnostics page (web) — reads from Supabase.
   ============================================================ */

function fieldValue(field) {
    if (!field || field.state !== "available" || field.value == null) return NORMAL_DASH;
    return String(field.value);
}

function set(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

// Supabase stores only the decoded columns (raw registers are not synced),
// so this table shows value/unit/scale/status — not raw hex/dec.
const DIAG_DEFS = [
    ["PV1 Voltage", "pv1_voltage", "V", 0.1, 1],
    ["PV1 Current", "pv1_current", "A", 0.1, 2],
    ["PV2 Voltage", "pv2_voltage", "V", 0.1, 1],
    ["PV2 Current", "pv2_current", "A", 0.1, 2],
    ["PV Power Total", "pv_power", "W", 1.0, 0],
    ["Grid Voltage", "grid_voltage", "V", 0.1, 1],
    ["Grid Frequency", "grid_frequency", "Hz", 0.01, 2],
    ["Battery Voltage", "battery_voltage", "V", 0.1, 1],
    ["Battery Current", "battery_current", "A", 0.1, 2],
    ["Battery Power", "battery_power", "W", 1.0, 0],
    ["Battery SOC", "battery_soc", "%", 1.0, 0],
    ["Battery SOH", "battery_soh", "%", 1.0, 0],
    ["House Load", "house_load", "W", 1.0, 0],
    ["Backup Load", "backup_load", "W", 1.0, 0],
];

function renderDiagTable(row) {
    const tbody = document.getElementById("diag-rows");
    if (!tbody) return;
    tbody.textContent = "";

    if (!row) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 5;
        td.className = "table-loading";
        td.textContent = "No data";
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
    }

    for (const [name, col, unit, scale, dp] of DIAG_DEFS) {
        const v = row[col];
        const ok = v != null && !Number.isNaN(Number(v));
        const tr = document.createElement("tr");
        const cell = (text) => {
            const td = document.createElement("td");
            td.textContent = text;
            tr.appendChild(td);
            return td;
        };
        cell(name);
        cell(ok ? Number(v).toFixed(dp) : NORMAL_DASH);
        cell(unit);
        cell(String(scale));
        const td = document.createElement("td");
        const span = document.createElement("span");
        span.className = "status-tag " + (ok ? "available" : "unavailable");
        span.textContent = ok ? "OK" : "N/A";
        td.appendChild(span);
        tr.appendChild(td);
        tbody.appendChild(tr);
    }
}

let _busy = false;
async function loadSystem() {
    if (_busy) return;
    _busy = true;
    try {
        const [row, sysInfo] = await Promise.all([
            fetchLatestReading(), fetchSystemInfo(),
        ]);
        const snapshot = buildSnapshot(row, sysInfo);
        if (!snapshot) throw new Error("no data");

        const sys = snapshot.system;
        set("sys-model", fieldValue(sys.inverter_model));
        set("sys-serial", fieldValue(sys.serial_number));
        set("sys-protocol", fieldValue(sys.protocol_version));
        set("sys-product", fieldValue(sys.product_model));
        set("sys-connection", sys.online ? "Connected" : "Disconnected");
        set("sys-last-read", snapshot.timestamp || NORMAL_DASH);
        // Error counters exist only on the laptop's Modbus reader and are not
        // synced to Supabase, so this page cannot report them.
        set("sys-last-error", NORMAL_DASH);

        renderDiagTable(row);
        updateGlobalStatus(snapshot);
        updateLastUpdate(snapshot);
    } catch (err) {
        set("sys-connection", "Offline");
        set("sys-last-error", "Cloud database unreachable");
        set("sys-last-read", NORMAL_DASH);
        const tbody = document.getElementById("diag-rows");
        if (tbody) {
            tbody.textContent = "";
            const tr = document.createElement("tr");
            const td = document.createElement("td");
            td.colSpan = 5;
            td.className = "table-loading";
            td.textContent = "Cloud data unavailable";
            tr.appendChild(td);
            tbody.appendChild(tr);
        }
        console.error("system load failed", err);
    } finally {
        _busy = false;
    }
}

// Exact row count is an expensive full-table aggregate; refresh it slowly.
let countBusy = false;
async function refreshTotalReadings() {
    if (countBusy) return;
    countBusy = true;
    try {
        const total = await countReadings();
        set("sys-total-reads", total == null ? NORMAL_DASH : total.toLocaleString());
    } catch (err) {
        set("sys-total-reads", NORMAL_DASH);
        console.error("reading count failed", err);
    } finally {
        countBusy = false;
    }
}

document.addEventListener("DOMContentLoaded", () => {
    loadSystem();
    refreshTotalReadings();
    setInterval(loadSystem, 2000);
    setInterval(refreshTotalReadings, 60000);
});

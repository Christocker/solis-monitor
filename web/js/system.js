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

async function loadSystem() {
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
        set("sys-last-read", snapshot.timestamp || "--");

        // Configuration (static info)
        set("sys-host", "Supabase (cloud)");
        set("sys-port", "—");
        set("sys-slave", "—");
        set("sys-timeout", "—");
        set("sys-poll", "2 s (cloud sync)");
        set("sys-read-errors", "0");
        set("sys-conn-errors", "0");
        set("sys-total-reads", await countReadings());
        set("sys-last-error", "None");

        renderDiagTable(row);

        updateGlobalStatus(snapshot);
        updateLastUpdate(snapshot);
    } catch (err) {
        updateGlobalStatus(null);
    }
}

function renderDiagTable(row) {
    const tbody = document.getElementById("diag-rows");
    if (!tbody) return;
    if (!row) {
        tbody.innerHTML = '<tr><td colspan="8" class="table-loading">No data</td></tr>';
        return;
    }

    const defs = [
        ["PV1 Voltage", "pv1_voltage", "V", 0.1],
        ["PV1 Current", "pv1_current", "A", 0.1],
        ["PV2 Voltage", "pv2_voltage", "V", 0.1],
        ["PV2 Current", "pv2_current", "A", 0.1],
        ["PV Power Total", "pv_power", "W", 1.0],
        ["Grid Voltage", "grid_voltage", "V", 0.1],
        ["Grid Frequency", "grid_frequency", "Hz", 0.01],
        ["Battery Voltage", "battery_voltage", "V", 0.1],
        ["Battery Current", "battery_current", "A", 0.1],
        ["Battery Power", "battery_power", "W", 1.0],
        ["Battery SOC", "battery_soc", "%", 1.0],
        ["Battery SOH", "battery_soh", "%", 1.0],
        ["House Load", "house_load", "W", 1.0],
        ["Backup Load", "backup_load", "W", 1.0],
    ];

    let html = "";
    for (const [name, col, unit, scale] of defs) {
        const v = row[col];
        const ok = v != null;
        html += `<tr>
            <td>${name}</td>
            <td>cloud</td>
            <td>—</td>
            <td>—</td>
            <td>${ok ? v : NORMAL_DASH}</td>
            <td>${unit}</td>
            <td>${scale}</td>
            <td><span class="status-tag ${ok ? "available" : "unavailable"}">${ok ? "OK" : "n/a"}</span></td>
        </tr>`;
    }
    tbody.innerHTML = html;
}

document.addEventListener("DOMContentLoaded", () => {
    loadSystem();
    setInterval(loadSystem, 5000);
});

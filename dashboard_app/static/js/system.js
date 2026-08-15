/* ============================================================
   System & Diagnostics page.
   ============================================================ */

async function loadConfig() {
    try {
        const cfg = await fetchJSON("/api/config");
        set("sys-host", cfg.host);
        set("sys-port", cfg.port);
        set("sys-slave", cfg.slave_id);
        set("sys-timeout", cfg.timeout + " s");
        set("sys-poll", cfg.poll_interval + " s");
        if (cfg.demo_mode) {
            set("sys-connection", "DEMO MODE");
        }
    } catch (e) { /* ignore */ }
}

async function loadStatus() {
    try {
        const d = await fetchJSON("/api/status");
        const sys = d.system;

        set("sys-model", fieldValue(sys.inverter_model));
        set("sys-serial", fieldValue(sys.serial_number));
        set("sys-protocol", fieldValue(sys.protocol_version));
        set("sys-product", fieldValue(sys.product_model));

        const online = sys.online;
        set("sys-connection", online ? "Connected" : "Disconnected");

        // Diagnostics endpoint for read stats
        const diag = await fetchJSON("/api/diagnostics");
        const stats = diag.stats;
        set("sys-last-read", stats.last_success_time || "--");
        set("sys-read-errors", stats.read_errors);
        set("sys-conn-errors", stats.connection_errors);
        set("sys-total-reads", stats.total_reads);
        set("sys-last-error", stats.last_error_message || "None");

        renderDiagTable(diag.rows);

        updateGlobalStatus(d);
        updateLastUpdate(d);
    } catch (e) {
        updateGlobalStatus(null);
    }
}

function fieldValue(field) {
    if (!field || field.state !== "available" || field.value == null) {
        return NORMAL_DASH;
    }
    return String(field.value);
}

function renderDiagTable(rows) {
    const tbody = document.getElementById("diag-rows");
    if (!tbody) return;

    if (!rows || rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="table-loading">No data</td></tr>';
        return;
    }

    let html = "";
    for (const row of rows) {
        const rawHex = row.raw_hex || NORMAL_DASH;
        const rawDec = row.raw_dec
            ? row.raw_dec.join(", ")
            : NORMAL_DASH;
        const decoded = row.decoded !== null && row.decoded !== undefined
            ? String(row.decoded)
            : NORMAL_DASH;

        let stateText = row.state;
        if (row.state === "available") stateText = "OK";
        else if (row.state === "error") stateText = "ERROR";

        const stateTagClass = {
            "available": "available",
            "unavailable": "unavailable",
            "unverified": "unverified",
            "error": "error",
        }[row.state] || "unavailable";

        html += `<tr>
            <td title="${(row.error || "").replace(/"/g, "&quot;")}">${row.parameter}</td>
            <td>${row.register}</td>
            <td>${rawHex}</td>
            <td>${rawDec}</td>
            <td>${decoded}</td>
            <td>${row.unit || ""}</td>
            <td>${row.scale}</td>
            <td><span class="status-tag ${stateTagClass}">${stateText}</span></td>
        </tr>`;
    }
    tbody.innerHTML = html;
}

function set(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

loadConfig();
loadStatus();
setInterval(loadStatus, 3000);

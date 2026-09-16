/* ============================================================
   System & Diagnostics page.
   ============================================================ */

function fmtTime(unixSeconds) {
    if (!unixSeconds) return NORMAL_DASH;
    return new Date(unixSeconds * 1000).toLocaleString();
}

async function loadConfig() {
    try {
        const cfg = await fetchJSON("/api/config");
        set("sys-host", cfg.host);
        set("sys-port", cfg.port);
        set("sys-slave", cfg.slave_id);
        set("sys-timeout", cfg.timeout + " s");
        set("sys-poll", cfg.poll_interval + " s");
    } catch (e) { /* ignore */ }
}

function fieldValue(field) {
    if (!field || field.state !== "available" || field.value == null) {
        return NORMAL_DASH;
    }
    return String(field.value);
}

const STATE_TEXT = {
    available: "OK",
    error: "ERROR",
    unavailable: "N/A",
    unverified: "UNVERIFIED",
};

function renderDiagTable(rows) {
    const tbody = document.getElementById("diag-rows");
    if (!tbody) return;
    tbody.textContent = "";

    if (!rows || rows.length === 0) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 9;
        td.className = "table-loading";
        td.textContent = "No data";
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
    }

    for (const row of rows) {
        const tr = document.createElement("tr");
        const cell = (text, title) => {
            const td = document.createElement("td");
            td.textContent = text;
            if (title) td.title = title;
            tr.appendChild(td);
        };
        const rawHex = row.raw_hex || NORMAL_DASH;
        const rawDec = Array.isArray(row.raw_dec)
            ? row.raw_dec.join(", ") : NORMAL_DASH;
        const decoded = (row.decoded !== null && row.decoded !== undefined)
            ? String(row.decoded) : NORMAL_DASH;

        cell(row.parameter, row.error || "");
        cell(row.register);
        cell(rawHex);
        cell(rawDec);
        cell(decoded);
        cell(row.unit || "");
        cell(row.scale);
        cell(row.confidence || NORMAL_DASH);

        const td = document.createElement("td");
        const span = document.createElement("span");
        span.className = "status-tag " + (row.state || "unavailable");
        span.textContent = STATE_TEXT[row.state] || row.state || NORMAL_DASH;
        td.appendChild(span);
        tr.appendChild(td);
        tbody.appendChild(tr);
    }
}

let _busy = false;
async function loadStatus() {
    if (_busy) return;
    _busy = true;
    try {
        const d = await fetchJSON("/api/status");
        const sys = d.system;
        set("sys-model", fieldValue(sys.inverter_model));
        set("sys-serial", fieldValue(sys.serial_number));
        set("sys-protocol", fieldValue(sys.protocol_version));
        set("sys-product", fieldValue(sys.product_model));
        set("sys-connection", d.demo ? "DEMO MODE"
            : (sys.online ? "Connected" : "Disconnected"));
        updateGlobalStatus(d);
        updateLastUpdate(d);
    } catch (e) {
        updateGlobalStatus(null);
    }

    // Diagnostics are independent: a failure here must not mark the system
    // offline or wipe the identity/status values above.
    try {
        const diag = await fetchJSON("/api/diagnostics");
        const stats = diag.stats;
        set("sys-last-read", fmtTime(stats.last_success_time));
        set("sys-read-errors", stats.read_errors);
        set("sys-conn-errors", stats.connection_errors);
        set("sys-total-reads", stats.total_reads);
        set("sys-last-error", stats.last_error_message
            ? stats.last_error_message + " (" + fmtTime(stats.last_error_time) + ")"
            : "None");
        renderDiagTable(diag.rows);
    } catch (e) { /* keep the last table */ }

    _busy = false;
}

function set(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

loadConfig();
loadStatus();
setInterval(loadStatus, 2000);

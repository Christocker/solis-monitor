/* ============================================================
   solis-monitor web — shared helpers + Supabase client.
   The website reads data from Supabase (cloud DB) that the
   laptop's cloud_sync.py uploads.
   ============================================================ */

const NORMAL_DASH = "\u2014";

// Render a field object {value, state, unit} -> display string.
// Never invents values: any non-available state -> "--"
function renderField(field, decimals) {
    if (!field || field.state !== "available" || field.value == null) {
        return NORMAL_DASH;
    }
    if (decimals === undefined) decimals = 1;
    return Number(field.value).toFixed(decimals);
}

async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
}

/* ---------------- Supabase client ---------------- */

function supabaseHeaders() {
    return {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
    };
}

// Fetch the most recent reading row from Supabase.
async function fetchLatestReading() {
    const url = SUPABASE_URL + "/rest/v1/readings" +
        "?select=*&order=ts_unix.desc&limit=1";
    const res = await fetch(url, { headers: supabaseHeaders() });
    if (!res.ok) throw new Error("Supabase HTTP " + res.status);
    const rows = await res.json();
    return rows[0] || null;
}

// Fetch system info row (serial, model).
async function fetchSystemInfo() {
    const url = SUPABASE_URL + "/rest/v1/system_info" +
        "?select=*&limit=1";
    const res = await fetch(url, { headers: supabaseHeaders() });
    if (!res.ok) throw new Error("Supabase HTTP " + res.status);
    const rows = await res.json();
    return rows[0] || null;
}

// Fetch the most recent readings in a time range (newest last for charts).
async function fetchReadings(startUnix, endUnix, limit) {
    // Fetch newest first so we always get the LATEST data even when the
    // day has more rows than the limit (2s cadence = ~35k rows/day).
    const params = ["select=*", "order=ts_unix.desc"];
    if (startUnix) params.push("ts_unix=gte." + startUnix);
    if (endUnix) params.push("ts_unix=lte." + endUnix);
    if (limit) params.push("limit=" + limit);
    const url = SUPABASE_URL + "/rest/v1/readings?" + params.join("&");
    const res = await fetch(url, { headers: supabaseHeaders() });
    if (!res.ok) throw new Error("Supabase HTTP " + res.status);
    const rows = await res.json();
    rows.reverse(); // newest-last (ascending) so aggregation treats rows[0] as oldest
    return rows;
}

// Count readings (for the meta endpoint).
async function countReadings() {
    const url = SUPABASE_URL + "/rest/v1/readings?select=id";
    const res = await fetch(url, { headers: supabaseHeaders() });
    if (!res.ok) throw new Error("Supabase HTTP " + res.status);
    const rows = await res.json();
    return rows.length;
}

/* ---------------- Snapshot builder ---------------- */

function field(value, unit) {
    if (value === null || value === undefined) {
        return { value: null, state: "unavailable", unit: unit || "" };
    }
    return { value: value, state: "available", unit: unit || "" };
}

// Build a normalized snapshot (same shape as the local Flask API)
// from a Supabase reading row.
function buildSnapshot(row, sysInfo) {
    if (!row) return null;
    const connected = (row.grid_voltage != null) && (row.grid_voltage >= 50);

    return {
        solar: {
            power: field(row.pv_power, "W"),
            pv1_voltage: field(row.pv1_voltage, "V"),
            pv1_current: field(row.pv1_current, "A"),
            pv2_voltage: field(row.pv2_voltage, "V"),
            pv2_current: field(row.pv2_current, "A"),
        },
        battery: {
            voltage: field(row.battery_voltage, "V"),
            current: field(row.battery_current, "A"),
            power: field(row.battery_power, "W"),
            soc: field(row.battery_soc, "%"),
            soh: field(row.battery_soh, "%"),
        },
        grid: {
            voltage: field(row.grid_voltage, "V"),
            frequency: field(row.grid_frequency, "Hz"),
            power: field(null, "W"),   // grid import/export not verified
            connected: connected,
        },
        load: {
            power: field(
                (row.house_load != null && row.house_load > 0)
                    ? row.house_load : row.backup_load, "W"),
            house_load: field(row.house_load, "W"),
            backup_power: field(row.backup_load, "W"),
        },
        energy: {
            today_solar: field(null, "kWh"),
            today_consumption: field(null, "kWh"),
            today_battery_charge: field(null, "kWh"),
            today_battery_discharge: field(null, "kWh"),
            grid_import: field(null, "kWh"),
            grid_export: field(null, "kWh"),
        },
        system: {
            online: row.ts_unix != null,
            last_update: row.ts_iso || null,
            inverter_model: field(sysInfo ? sysInfo.inverter_model : null),
            serial_number: field(sysInfo ? sysInfo.serial_number : null),
            protocol_version: field(sysInfo ? sysInfo.protocol_version : null),
            product_model: field(sysInfo ? sysInfo.product_model : null),
        },
        timestamp: row.ts_iso || null,
        demo: false,
    };
}

// Update the sidebar global status + demo badge.
function updateGlobalStatus(snapshot) {
    const el = document.getElementById("global-status");
    if (!el) return;
    if (!snapshot) {
        el.innerHTML = '<span class="dot dot-error"></span><span>Offline</span>';
        return;
    }
    if (snapshot.system && snapshot.system.online) {
        el.innerHTML = '<span class="dot dot-ok"></span><span>System online</span>';
    } else {
        el.innerHTML = '<span class="dot dot-error"></span><span>Offline</span>';
    }
}

function updateLastUpdate(snapshot) {
    const el = document.getElementById("last-update") ||
               document.getElementById("sys-last-update") ||
               document.getElementById("history-status");
    if (el && snapshot && snapshot.timestamp) {
        el.textContent = "Last update: " + snapshot.timestamp;
    }
}

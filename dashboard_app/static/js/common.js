/* ============================================================
   Solis Monitor — common helpers
   ============================================================ */

const NORMAL_DASH = "\u2014";   // em dash "--"

// Render a normalized field dict -> display string.
// Never invents values: unverified/unavailable/error -> "--"
function renderField(field, decimals) {
    if (!field || field.state !== "available" || field.value == null) {
        return NORMAL_DASH;
    }
    if (decimals === undefined) decimals = 1;
    return Number(field.value).toFixed(decimals);
}

// Render a value directly (string/number) or "--" if not a number.
function renderValue(value, decimals) {
    if (value === null || value === undefined || isNaN(value)) {
        return NORMAL_DASH;
    }
    if (decimals === undefined) decimals = 1;
    return Number(value).toFixed(decimals);
}

// Fetch JSON with a timeout.
async function fetchJSON(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error("HTTP " + res.status);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

// Fetch readings in a time range (start_unix, end_unix) from the local API,
// newest-last so the history chart's aggregation treats rows[0] as oldest.
async function fetchReadings(startUnix, endUnix, limit) {
    let url = "/api/history?limit=" + (limit || 10000);
    if (startUnix) url += "&start=" + startUnix;
    if (endUnix) url += "&end=" + endUnix;
    const data = await fetchJSON(url);
    const rows = (data && data.rows) || [];
    rows.sort((a, b) => a.ts_unix - b.ts_unix);
    return rows;
}

// Update the sidebar global status pill based on snapshot.
function updateGlobalStatus(snapshot) {
    const el = document.getElementById("global-status");
    if (!el) return;
    if (!snapshot) {
        el.innerHTML = '<span class="dot dot-waiting"></span><span>Offline</span>';
        return;
    }
    const demo = snapshot.demo;
    const online = snapshot.system && snapshot.system.online;

    if (demo) {
        el.innerHTML = '<span class="dot dot-warn"></span><span>DEMO</span>';
        const badge = document.getElementById("demo-badge");
        if (badge) badge.style.display = "inline-block";
        return;
    }
    if (online) {
        el.innerHTML = '<span class="dot dot-ok"></span><span>System online</span>';
    } else {
        el.innerHTML = '<span class="dot dot-error"></span><span>Offline</span>';
    }
}

// Update "Last update" text from snapshot timestamp.
function updateLastUpdate(snapshot) {
    const el = document.getElementById("last-update") ||
               document.getElementById("sys-last-update");
    if (el && snapshot && snapshot.timestamp) {
        el.textContent = "Last update: " + snapshot.timestamp;
    }
}

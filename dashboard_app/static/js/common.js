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

// Fetch downsampled history: the server aggregates readings into ~buckets
// time buckets (one row each) so the full history can be charted in one
// request. start/end may be null to cover everything from the first record.
async function fetchHistoryBuckets(startUnix, endUnix, buckets, onProgress) {
    const params = new URLSearchParams({ buckets: buckets });
    if (startUnix != null) params.set("start", startUnix);
    if (endUnix != null) params.set("end", endUnix);
    if (onProgress) onProgress(1, 1);   // single local request
    const data = await fetchJSON("/api/history/buckets?" + params.toString());
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

// Human-readable age, e.g. "12s ago".
function ageText(seconds) {
    if (seconds == null || isNaN(seconds)) return "";
    const s = Math.max(0, Math.round(seconds));
    if (s < 5) return "just now";
    if (s < 60) return s + "s ago";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60);
    if (h < 48) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
}

// Update "Last update" text with the age of the data (re-render every second).
function updateLastUpdate(snapshot) {
    const el = document.getElementById("last-update") ||
               document.getElementById("sys-last-update");
    if (!el || !snapshot) return;
    const ts = snapshot.system && snapshot.system.data_ts_unix != null
        ? snapshot.system.data_ts_unix : null;
    if (ts != null) {
        const age = Date.now() / 1000 - ts;
        el.textContent = "Updated " + ageText(age);
        el.title = snapshot.timestamp || "";
        el.classList.toggle("age-stale", age > 30);
        el.classList.toggle("age-warn", age > 10 && age <= 30);
    } else if (snapshot.timestamp) {
        el.textContent = "Last update: " + snapshot.timestamp;
    }
}


/* ---------------- Theme (light / dark) ---------------- */
function setupTheme() {
    const root = document.documentElement;
    let btn = document.getElementById("theme-toggle");
    if (!btn) {
        const host = document.querySelector(".topbar-right");
        if (host) {
            btn = document.createElement("button");
            btn.id = "theme-toggle";
            btn.type = "button";
            btn.className = "theme-toggle";
            btn.setAttribute("aria-label", "Toggle dark mode");
            btn.title = "Toggle light/dark theme";
            host.appendChild(btn);
        }
    }
    const moon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
    const sun = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.9" y1="4.9" x2="6.3" y2="6.3"/><line x1="17.7" y1="17.7" x2="19.1" y2="19.1"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.9" y1="19.1" x2="6.3" y2="17.7"/><line x1="17.7" y1="6.3" x2="19.1" y2="4.9"/></svg>';

    function apply(theme) {
        root.dataset.theme = theme;
        if (btn) btn.innerHTML = theme === "dark" ? sun : moon;
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute("content", theme === "dark" ? "#0b0b0d" : "#f5f5f7");
        window.dispatchEvent(new Event("themechange"));
    }
    if (btn) {
        btn.addEventListener("click", () => {
            const next = root.dataset.theme === "dark" ? "light" : "dark";
            try { localStorage.setItem("theme", next); } catch (e) {}
            apply(next);
        });
    }
    const mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    if (mq && mq.addEventListener) {
        mq.addEventListener("change", (e) => {
            let saved = null;
            try { saved = localStorage.getItem("theme"); } catch (err) {}
            if (!saved) apply(e.matches ? "dark" : "light");
        });
    }
    if (btn) btn.innerHTML = root.dataset.theme === "dark" ? sun : moon;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", root.dataset.theme === "dark" ? "#0b0b0d" : "#f5f5f7");
}

document.addEventListener("DOMContentLoaded", setupTheme);

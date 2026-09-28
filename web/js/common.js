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

/* ---------------- Supabase client ---------------- */

function supabaseHeaders() {
    return {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
    };
}

// fetch() with a timeout so a stalled connection can never hang the page.
// A timeout is retryable (the history splitter may re-request a smaller range).
async function supabaseFetch(url, options = {}, timeoutMs = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (e) {
        const err = new Error("Supabase request failed or timed out");
        err.retryable = true;
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

// Fetch the most recent reading row from Supabase (cached for offline use).
async function fetchLatestReading() {
    const url = SUPABASE_URL + "/rest/v1/readings" +
        "?select=*&order=ts_unix.desc&limit=1";
    const res = await supabaseFetch(url, { headers: supabaseHeaders() });
    if (!res.ok) throw new Error("Supabase HTTP " + res.status);
    const rows = await res.json();
    const row = rows[0] || null;
    if (row) {
        try { localStorage.setItem("solis:last", JSON.stringify(row)); } catch (e) {}
    }
    return row;
}

// Register the service worker (PWA install + offline shell/data).
if ("serviceWorker" in navigator && location.protocol.indexOf("http") === 0) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
}

// Cloud-sync heartbeat row (written by the laptop). Null if unavailable.
async function fetchSyncStatus() {
    try {
        const url = SUPABASE_URL + "/rest/v1/sync_status?id=eq.1&select=*&limit=1";
        const res = await supabaseFetch(url, { headers: supabaseHeaders() });
        if (!res.ok) return null;
        const rows = await res.json();
        return rows[0] || null;
    } catch (e) { return null; }
}

// Fetch system info row (serial, model).
async function fetchSystemInfo() {
    const url = SUPABASE_URL + "/rest/v1/system_info" +
        "?select=*&limit=1";
    const res = await supabaseFetch(url, { headers: supabaseHeaders() });
    if (!res.ok) throw new Error("Supabase HTTP " + res.status);
    const rows = await res.json();
    return rows[0] || null;
}

// Fetch the most recent readings in a time range (newest last for charts).
async function fetchReadings(startUnix, endUnix, limit) {
    // PostgREST caps a response at ~1000 rows; never request more.
    const capped = Math.min(limit || 1000, 1000);
    const params = ["select=*", "order=ts_unix.desc", "limit=" + capped];
    if (startUnix != null) params.push("ts_unix=gte." + startUnix);
    if (endUnix != null) params.push("ts_unix=lte." + endUnix);
    const url = SUPABASE_URL + "/rest/v1/readings?" + params.join("&");
    const res = await supabaseFetch(url, { headers: supabaseHeaders() });
    if (!res.ok) throw new Error("Supabase HTTP " + res.status);
    const rows = await res.json();
    rows.reverse(); // newest-last (ascending) so aggregation treats rows[0] as oldest
    return rows;
}

// Fetch downsampled history via the Supabase RPC `history_buckets`, which
// aggregates the raw table into ~buckets rows server-side (the API caps raw
// responses at 1000 rows). start/end may be omitted to cover the full range.
//
// A whole-range scan can exceed the API statement timeout, so the range is
// split into ~1-day chunks (each comfortably under the limit) and merged.
// Chunks run a couple at a time to avoid overloading the database, and a chunk
// that still times out is split further (under a global call budget).
const HISTORY_CHUNK_SECONDS = 24 * 3600;
const HISTORY_CONCURRENCY = 2;
const HISTORY_MAX_CALLS = 200;
let _rpcCalls = 0;

// Cache merged bucket results for a window so revisiting a past window (or
// re-opening "All") is instant instead of re-running the whole chunked scan.
const HISTORY_CACHE_TTL_MS = 2 * 60 * 1000;
function _histCacheKey(s, e, buckets) {
    return "hist:" + Math.round(s) + ":" + Math.round(e) + ":" + buckets;
}
function _histCacheGet(key) {
    try {
        const raw = sessionStorage.getItem(key);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (Date.now() - obj.t > HISTORY_CACHE_TTL_MS) {
            sessionStorage.removeItem(key);
            return null;
        }
        return obj.rows;
    } catch (e) { return null; }
}
function _histCacheSet(key, rows) {
    try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), rows })); }
    catch (e) { /* quota/unavailable: caching is optional */ }
}

async function fetchHistoryBuckets(startUnix, endUnix, buckets, onProgress) {
    _rpcCalls = 0;
    let s = startUnix, e = endUnix;
    if (s == null || e == null) {
        const bounds = await fetchReadingsBounds();
        if (!bounds) return [];
        if (s == null) s = bounds.min;
        if (e == null) e = bounds.max;
    }
    if (!(e > s)) return await historyBucketsCall(s, e, buckets);

    // Cache under a stable key. For "All" (no explicit bounds) the resolved
    // max grows every second, so key it as "all" instead of by bounds.
    const cacheKey = (startUnix == null && endUnix == null)
        ? "hist:all:" + buckets
        : _histCacheKey(s, e, buckets);
    const cached = _histCacheGet(cacheKey);
    if (cached) {
        if (onProgress) onProgress(1, 1);
        return cached;
    }

    const span = e - s;
    const n = Math.max(1, Math.ceil(span / HISTORY_CHUNK_SECONDS));
    if (n === 1) {
        const rows = await historyBucketsCall(s, e, buckets);
        _histCacheSet(cacheKey, rows);
        return rows;
    }

    const jobs = [];
    const base = Math.floor(buckets / n);
    let rem = buckets - base * n;
    for (let i = 0; i < n; i++) {
        const cs = s + (span * i) / n;
        // Half-open upper bound so a sample exactly on the boundary is not
        // counted in two chunks.
        const ce = (i === n - 1) ? e : s + (span * (i + 1)) / n - 1e-6;
        const cb = Math.max(1, base + (rem-- > 0 ? 1 : 0));
        jobs.push(() => historyBucketsCall(cs, ce, cb));
    }
    const results = await runLimited(jobs, HISTORY_CONCURRENCY, onProgress);
    const rows = [].concat(...results);
    rows.sort((a, b) => a.ts_unix - b.ts_unix);
    _histCacheSet(cacheKey, rows);
    return rows;
}

// Run async jobs with a cap on how many run at once.
async function runLimited(jobs, limit, onProgress) {
    const results = new Array(jobs.length);
    let next = 0, done = 0;
    async function worker() {
        while (next < jobs.length) {
            const i = next++;
            results[i] = await jobs[i]();
            done++;
            if (onProgress) onProgress(done, jobs.length);
        }
    }
    const workers = [];
    for (let i = 0; i < Math.min(limit, jobs.length); i++) workers.push(worker());
    await Promise.all(workers);
    return results;
}

// One RPC call; on a retryable (server-side) failure, split the range in half.
async function historyBucketsCall(startUnix, endUnix, buckets) {
    if (_rpcCalls >= HISTORY_MAX_CALLS) {
        throw new Error("history_buckets: call budget exhausted");
    }
    _rpcCalls++;
    try {
        return await historyBucketsRpc(startUnix, endUnix, buckets);
    } catch (err) {
        if (err.rpcUnavailable) throw err;
        const span = endUnix - startUnix;
        if (!err.retryable || span < 3600) throw err;
        const mid = startUnix + span / 2;
        const b1 = Math.max(1, Math.round(buckets / 2));
        const b2 = Math.max(1, buckets - b1);
        const [a, b] = await Promise.all([
            historyBucketsCall(startUnix, mid, b1),
            historyBucketsCall(mid, endUnix, b2),
        ]);
        return a.concat(b);
    }
}

async function historyBucketsRpc(startUnix, endUnix, buckets) {
    const body = { p_start: startUnix, p_end: endUnix, p_buckets: buckets };
    const res = await supabaseFetch(SUPABASE_URL + "/rest/v1/rpc/history_buckets", {
        method: "POST",
        headers: supabaseHeaders(),
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const err = new Error("Supabase RPC HTTP " + res.status);
        if (res.status === 404) {
            err.rpcUnavailable = true;   // function not installed
        } else if (res.status >= 500) {
            err.retryable = true;        // server timeout / overload
        }
        // Other 4xx (400/401/403/422/429) are permanent, so do not retry.
        throw err;
    }
    const rows = await res.json();
    rows.forEach((r) => { r.ts_unix = r.bucket_ts; });
    return rows;
}

// First and last recorded timestamps (for the full-range "All" view).
async function fetchReadingsBounds() {
    const base = SUPABASE_URL + "/rest/v1/readings?select=ts_unix&limit=1&order=";
    const [minRes, maxRes] = await Promise.all([
        supabaseFetch(base + "ts_unix.asc", { headers: supabaseHeaders() }),
        supabaseFetch(base + "ts_unix.desc", { headers: supabaseHeaders() }),
    ]);
    if (!minRes.ok || !maxRes.ok) {
        const st = [minRes.ok ? null : minRes.status,
                    maxRes.ok ? null : maxRes.status].filter(Boolean).join("/");
        throw new Error("Supabase HTTP " + st);
    }
    const [minRow] = await minRes.json();
    const [maxRow] = await maxRes.json();
    if (!minRow || !maxRow) return null;
    return { min: minRow.ts_unix, max: maxRow.ts_unix };
}

// Exact number of readings (uses the count header; a plain select is capped).
async function countReadings() {
    const url = SUPABASE_URL + "/rest/v1/readings?select=id&limit=1";
    const res = await supabaseFetch(url, {
        headers: { ...supabaseHeaders(), "Prefer": "count=estimated", "Range": "0-0" },
    });
    if (!res.ok) throw new Error("Supabase HTTP " + res.status);
    const range = res.headers.get("content-range");
    if (range && range.includes("/")) {
        const total = range.split("/")[1];
        if (total && total !== "*") return Number(total);
    }
    return null;
}

/* ---------------- Energy totals ---------------- */

const ENERGY_GAP_SECONDS = 600;   // fallback gap cap for raw rows

// Largest interval we trust when integrating. Bucketed rows carry the
// server's bucket width; otherwise estimate from the series spacing. This
// keeps lifetime integration (coarse buckets) working while still skipping
// real data gaps.
function energyMaxGap(rows) {
    if (rows.length && rows[0].bucket_width != null) {
        return rows[0].bucket_width * 1.5;
    }
    if (rows.length > 1) {
        const dts = [];
        for (let i = 1; i < rows.length; i++) dts.push(rows[i].ts_unix - rows[i - 1].ts_unix);
        dts.sort((a, b) => a - b);
        const median = dts[Math.floor(dts.length / 2)];
        return Math.max(1, median) * 1.5;
    }
    return ENERGY_GAP_SECONDS;
}

// Grid energy is derived from the power balance, so it is only integrated
// once the battery sign is trustworthy (post battery-direction fix).
const GRID_ENERGY_VALID_FROM = 1789860600;   // 2026-09-20 07:30 +0800
const GRID_CONNECTED_V = 50;

// Integrate power buckets into energy (kWh). Returns field objects shaped
// like snapshot.energy so the dashboard's updateEnergy() can render them.
function computeEnergy(rows) {
    const unavailable = () => ({ value: null, state: "unavailable", unit: "kWh" });
    if (!rows || rows.length < 2) {
        return {
            today_solar: unavailable(), today_consumption: unavailable(),
            today_battery_charge: unavailable(), today_battery_discharge: unavailable(),
            grid_import: unavailable(), grid_export: unavailable(),
        };
    }
    const maxGap = energyMaxGap(rows);
    let solar = 0, consumption = 0, charge = 0, discharge = 0;
    let gridImport = 0, gridExport = 0;
    let prev = null;
    for (const r of rows) {
        const load = (r.house_load || 0) + (r.backup_load || 0);
        if (prev) {
            const dt = r.ts_unix - prev.ts;
            if (dt > 0 && dt <= maxGap) {
                if (prev.pv != null && r.pv_power != null)
                    solar += (prev.pv + r.pv_power) / 2 * dt;
                if (prev.load != null)
                    consumption += (prev.load + load) / 2 * dt;
                if (prev.batt != null && r.battery_power != null) {
                    const e = (prev.batt + r.battery_power) / 2 * dt;
                    if (e > 0) discharge += e; else charge += -e;
                }
                // Derived grid import/export (on-grid intervals only).
                if (r.ts_unix >= GRID_ENERGY_VALID_FROM
                        && prev.ts >= GRID_ENERGY_VALID_FROM
                        && prev.gv != null && r.grid_voltage != null
                        && prev.gv >= GRID_CONNECTED_V && r.grid_voltage >= GRID_CONNECTED_V
                        && prev.pv != null && r.pv_power != null
                        && prev.batt != null && r.battery_power != null
                        && prev.load != null) {
                    const gPrev = prev.load - prev.pv - prev.batt;
                    const gNow = load - r.pv_power - r.battery_power;
                    const e = (gPrev + gNow) / 2 * dt;
                    if (e >= 0) gridImport += e; else gridExport += -e;
                }
            }
        }
        prev = { ts: r.ts_unix, pv: r.pv_power, batt: r.battery_power,
                 load: load, gv: r.grid_voltage };
    }
    const kwh = 3.6e6;
    const field = (v) => ({
        value: Math.round(v / kwh * 1000) / 1000, state: "available", unit: "kWh",
    });
    return {
        today_solar: field(solar),
        today_consumption: field(consumption),
        today_battery_charge: field(charge),
        today_battery_discharge: field(discharge),
        grid_import: field(gridImport),
        grid_export: field(gridExport),
    };
}

/* ---------------- Snapshot builder ---------------- */

function field(value, unit) {
    if (value === null || value === undefined) {
        return { value: null, state: "unavailable", unit: unit || "" };
    }
    return { value: value, state: "available", unit: unit || "" };
}

// Grid power is derived from the balance of measured powers (there is no grid
// meter):  grid = load - pv - battery   (+battery = discharging)
// positive = importing, negative = exporting. Null when not derivable.
const GRID_POWER_DEADBAND_W = 50;
function derivedGridPower(row) {
    if (!row || row.grid_voltage == null || row.grid_voltage < 50) return null;
    if (row.pv_power == null || row.battery_power == null) return null;
    if (row.house_load == null && row.backup_load == null) return null;
    const load = (row.house_load || 0) + (row.backup_load || 0);
    let p = load - row.pv_power - row.battery_power;
    if (Math.abs(p) < GRID_POWER_DEADBAND_W) p = 0;
    return p;
}

// Total consumption = house + backup ports (33147 is normally 0 on this
// installation and 33148 carries the load in both grid states).
function totalLoad(row) {
    if (row.house_load == null && row.backup_load == null) return null;
    return (row.house_load || 0) + (row.backup_load || 0);
}

// Build a normalized snapshot (same shape as the local Flask API)
// from a Supabase reading row.
function buildSnapshot(row, sysInfo) {
    if (!row) return null;
    const connected = row.grid_voltage == null ? null : (row.grid_voltage >= 50);
    // "Online" means the cloud feed is fresh, not merely that a row exists
    // (rows are never deleted, so presence alone would always read Online).
    const STALE_SECONDS = 30;
    const ageS = (row.ts_unix != null)
        ? Date.now() / 1000 - Number(row.ts_unix) : Infinity;
    const fresh = ageS >= 0 && ageS < STALE_SECONDS;

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
            power: field(derivedGridPower(row), "W"),   // derived estimate
            connected: connected,
        },
        load: {
            power: field(totalLoad(row), "W"),
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
            online: fresh,
            last_update: row.ts_iso || null,
            data_ts_unix: row.ts_unix != null ? Number(row.ts_unix) : null,
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
               document.getElementById("sys-last-update") ||
               document.getElementById("history-status");
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

/* Mark the active nav/tab link for assistive tech. */
document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll(".nav-link.active, .tab-link.active").forEach((a) => {
        a.setAttribute("aria-current", "page");
    });
});

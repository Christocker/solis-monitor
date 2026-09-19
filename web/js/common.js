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

// Fetch the most recent reading row from Supabase.
async function fetchLatestReading() {
    const url = SUPABASE_URL + "/rest/v1/readings" +
        "?select=*&order=ts_unix.desc&limit=1";
    const res = await supabaseFetch(url, { headers: supabaseHeaders() });
    if (!res.ok) throw new Error("Supabase HTTP " + res.status);
    const rows = await res.json();
    return rows[0] || null;
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
        headers: { ...supabaseHeaders(), "Prefer": "count=exact", "Range": "0-0" },
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
            }
        }
        prev = { ts: r.ts_unix, pv: r.pv_power, batt: r.battery_power, load: load };
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
        // No dedicated grid import/export meter exists on this inverter.
        grid_import: unavailable(),
        grid_export: unavailable(),
    };
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
            power: field(null, "W"),   // grid import/export not verified
            connected: connected,
        },
        load: {
            // Match the local backend: pick the port that is actually in use
            // (backup when off-grid, grid port otherwise).
            power: field(
                connected === false ? row.backup_load : row.house_load, "W"),
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

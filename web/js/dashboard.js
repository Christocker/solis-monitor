/* ============================================================
   Dashboard page (web) — polls Supabase and updates the UI.
   Same layout/logic as the local version, data from the cloud.
   ============================================================ */

let lastGood = null;
let lastValues = {};

function flash(el) {
    if (!el) return;
    el.classList.remove("value-flash");
    void el.offsetWidth;
    el.classList.add("value-flash");
    setTimeout(() => el.classList.remove("value-flash"), 600);
}

function setValue(id, text) {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.textContent !== text && lastValues[id] !== undefined) flash(el);
    lastValues[id] = text;
    el.textContent = text;
}

function updateStatusBanner(snapshot) {
    const pill = document.querySelector("#status-banner .status-pill");
    const gridPill = document.getElementById("grid-status-pill");
    const gridStatusText = document.getElementById("grid-status-text");
    const online = snapshot.system && snapshot.system.online;

    if (online) {
        pill.className = "status-pill pill-ok";
        pill.innerHTML = '<span class="dot dot-ok"></span> SYSTEM ONLINE';
    } else {
        pill.className = "status-pill pill-error";
        pill.innerHTML = '<span class="dot dot-error"></span> SYSTEM OFFLINE';
    }

    const connected = snapshot.grid && snapshot.grid.connected;
    if (connected === true) {
        gridPill.className = "status-pill pill-ok";
        gridPill.innerHTML = '<span class="dot dot-ok"></span> GRID CONNECTED';
        if (gridStatusText) gridStatusText.textContent = "Grid Connected";
    } else if (connected === false) {
        gridPill.className = "status-pill pill-warn";
        gridPill.innerHTML = '<span class="dot dot-warn"></span> GRID DISCONNECTED';
        if (gridStatusText) gridStatusText.textContent = "Grid Disconnected";
    } else {
        gridPill.className = "status-pill pill-muted";
        gridPill.innerHTML = '<span class="dot dot-waiting"></span> GRID --';
        if (gridStatusText) gridStatusText.textContent = "Grid --";
    }
}

function updateSolar(s) {
    setValue("solar-power", renderField(s.power, 0));
    setValue("pv1-voltage", renderField(s.pv1_voltage, 1));
    setValue("pv1-current", renderField(s.pv1_current, 2));
    setValue("pv2-voltage", renderField(s.pv2_voltage, 1));
    setValue("pv2-current", renderField(s.pv2_current, 2));
}

function updateBattery(b) {
    setValue("batt-soc", renderField(b.soc, 0));
    setValue("batt-soh", renderField(b.soh, 0));
    setValue("batt-voltage", renderField(b.voltage, 1));
    setValue("batt-voltage-meta", renderField(b.voltage, 1));
    setValue("batt-current", renderField(b.current, 2));
    setValue("batt-power", renderField(b.power, 0));
    const soc = b.soc && b.soc.state === "available" ? Number(b.soc.value) : 0;
    const fill = document.getElementById("soc-ring-fill");
    if (fill) {
        const r = 38;
        const circ = 2 * Math.PI * r;
        fill.style.strokeDasharray = circ.toFixed(2);
        fill.style.strokeDashoffset = (circ * (1 - Math.max(0, Math.min(100, soc)) / 100)).toFixed(2);
        fill.style.stroke = soc >= 50 ? "var(--battery)" : (soc >= 20 ? "var(--warning)" : "var(--danger)");
    }
}

function updateGrid(g) {
    setValue("grid-power", renderField(g.power, 0));
    setValue("grid-voltage", renderField(g.voltage, 1));
    setValue("grid-frequency", renderField(g.frequency, 2));
    const connEl = document.getElementById("grid-connection");
    if (connEl) {
        if (g.connected === true) connEl.textContent = "Connected";
        else if (g.connected === false) connEl.textContent = "Disconnected";
        else connEl.textContent = NORMAL_DASH;
    }
}

function updateLoad(l, snapshot) {
    setValue("load-power", renderField(l.power, 0));
    setValue("house-load", renderField(l.house_load, 0));
    setValue("backup-load", renderField(l.backup_power, 0));
    const source = document.getElementById("load-source");
    if (source) {
        const gridConn = snapshot && snapshot.grid && snapshot.grid.connected;
        source.textContent = gridConn === false
            ? "Load Power (Backup port)" : "Load Power (Grid port)";
    }
}

function updateEnergy(e) {
    setValue("stat-today-solar", renderField(e.today_solar, 1));
    setValue("stat-today-consumption", renderField(e.today_consumption, 1));
    setValue("stat-today-batt-charge", renderField(e.today_battery_charge, 1));
    setValue("stat-today-batt-discharge", renderField(e.today_battery_discharge, 1));
    setValue("stat-grid-import", renderField(e.grid_import, 1));
    setValue("stat-grid-export", renderField(e.grid_export, 1));
}

function updateFlow(snapshot) {
    const s = snapshot.solar, b = snapshot.battery,
          g = snapshot.grid, l = snapshot.load;

    const pvPower = s.power && s.power.state === "available" ? Number(s.power.value) : null;
    const battPower = b.power && b.power.state === "available" ? Number(b.power.value) : null;
    const gridPower = g.power && g.power.state === "available" ? Number(g.power.value) : null;
    const loadPower = l.power && l.power.state === "available" ? Number(l.power.value) : null;
    const battCurrent = b.current && b.current.state === "available" ? Number(b.current.value) : null;
    const gridConnected = snapshot.grid && snapshot.grid.connected;

    setValue("flow-solar-w", pvPower === null ? "--" : pvPower.toFixed(0) + " W");
    setValue("flow-load-w", loadPower === null ? "--" : loadPower.toFixed(0) + " W");
    // Battery: positive = discharging (power out), negative = charging (power into battery).
    setValue("flow-batt-w", battPower === null ? "--"
        : (Math.round(Math.abs(battPower)) === 0 ? "0 W"
           : (battPower > 0 ? "out " : "in ") + Math.abs(battPower).toFixed(0) + " W"));

    if (gridConnected === false) setValue("flow-grid-w", "DISCONNECTED");
    else if (gridPower === null) setValue("flow-grid-w", "--");
    else setValue("flow-grid-w", (gridPower >= 0 ? "imp " : "exp ") + Math.abs(gridPower).toFixed(0) + " W");

    // ---- Connectors ----
    // Each link has a fixed axis; energy flows toward its destination:
    //   solar   : vertical, flows DOWN into the hub
    //   grid    : vertical, import flows UP into the hub, export DOWN to grid
    //   battery : horizontal (node sits left of the hub)
    //   load    : horizontal (node sits right of the hub)
    setLink("flow-solar-inv", "down", pvPower, "pv");
    setLink("flow-inv-load", "right", loadPower, "load");

    // Battery: positive power = discharging (battery -> hub, flows right),
    // negative = charging (hub -> battery — the flow points AT the battery).
    const battDir = battPower !== null ? Math.sign(battPower)
                  : (battCurrent !== null ? Math.sign(battCurrent) : 0);
    if (battPower === null && battCurrent === null) {
        setLink("flow-batt-inv", "right", null, "batt");
    } else if (battDir < 0) {
        setLink("flow-batt-inv", "left", 1, "batt");     // charging -> INTO battery
    } else if (battDir > 0) {
        setLink("flow-batt-inv", "right", 1, "batt");    // discharging -> into hub
    } else {
        setLink("flow-batt-inv", "right", 0, "batt");    // idle -> plain line
    }

    // Grid.
    if (gridConnected === false) {
        setLink("flow-inv-grid", "up", null, "grid", "offline");
    } else if (gridPower !== null && gridPower > 0) {
        setLink("flow-inv-grid", "up", 1, "grid");       // import -> into hub
    } else if (gridPower !== null && gridPower < 0) {
        setLink("flow-inv-grid", "down", 1, "grid");     // export -> to grid
    } else if (gridConnected === true) {
        setLink("flow-inv-grid", "up", 0, "grid");       // connected, idle -> line
    } else {
        setLink("flow-inv-grid", "up", null, "grid");
    }
}

// Draw one connector.
//   direction : fixed axis + flow direction ("up" | "down" | "left" | "right")
//   power     : null = unknown (hidden), 0 = idle (plain line),
//               > 0 = flowing (animated dashes + comet + arrowhead)
//   mode      : "offline" = faint dashed line (grid disconnected)
function setLink(id, direction, power, colorClass, mode) {
    const el = document.getElementById(id);
    if (!el) return;
    const link = el.querySelector(".flow-arrow");
    if (!link) return;
    link.className = "flow-arrow " + direction;
    if (mode === "offline") {
        link.classList.add("offline");
    } else if (power === null) {
        link.classList.add("hidden");
    } else if (power > 0) {
        link.classList.add("active", colorClass);
    } else {
        link.classList.add("line");
    }
}

async function poll() {
    try {
        const [row, sysInfo] = await Promise.all([
            fetchLatestReading(), fetchSystemInfo(),
        ]);
        const snapshot = buildSnapshot(row, sysInfo);
        lastGood = snapshot;
        if (!snapshot) throw new Error("no data yet");
        updateStatusBanner(snapshot);
        updateSolar(snapshot.solar);
        updateBattery(snapshot.battery);
        updateGrid(snapshot.grid);
        updateLoad(snapshot.load, snapshot);
        updateFlow(snapshot);
        updateGlobalStatus(snapshot);
        updateLastUpdate(snapshot);
    } catch (err) {
        updateGlobalStatus(null);
        const pill = document.querySelector("#status-banner .status-pill");
        if (pill) {
            pill.className = "status-pill pill-error";
            pill.innerHTML = '<span class="dot dot-error"></span> NO DATA FROM CLOUD';
        }
    }
}

// Today's energy totals are integrated from recorded history (not the live
// snapshot) and refresh every 60s rather than on every 2s poll.
function startOfTodayUnix() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
}

let energyBusy = false;
async function refreshEnergy() {
    if (energyBusy) return;
    energyBusy = true;
    try {
        const now = Math.floor(Date.now() / 1000);
        const rows = await fetchHistoryBuckets(startOfTodayUnix(), now, 480);
        updateEnergy(computeEnergy(rows));
    } catch (err) {
        console.error("energy refresh failed", err);
    } finally {
        energyBusy = false;
    }
}

poll();
setInterval(poll, 2000);
refreshEnergy();
setInterval(refreshEnergy, 60000);

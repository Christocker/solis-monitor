/* ============================================================
   Dashboard page — polls /api/status and updates the UI.
   ============================================================ */

let lastGood = null;
let lastValues = {};   // track previous values to flash on change

function flash(el) {
    if (!el) return;
    el.classList.remove("value-flash");
    // Force reflow so the class re-triggers the transition
    void el.offsetWidth;
    el.classList.add("value-flash");
    setTimeout(() => el.classList.remove("value-flash"), 600);
}

// Set text and flash if the value changed from the previous poll.
function setValue(id, text) {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.textContent !== text && lastValues[id] !== undefined) {
        flash(el);
    }
    lastValues[id] = text;
    el.textContent = text;
}

function updateStatusBanner(snapshot) {
    const banner = document.getElementById("status-banner");
    const pill = banner.querySelector(".status-pill");
    const gridPill = document.getElementById("grid-status-pill");
    const gridStatusText = document.getElementById("grid-status-text");

    const online = snapshot.system && snapshot.system.online;

    if (snapshot.demo) {
        pill.className = "status-pill pill-warn";
        pill.innerHTML = '<span class="dot dot-warn"></span> DEMO DATA — NOT LIVE';
    } else if (online) {
        pill.className = "status-pill pill-ok";
        pill.innerHTML = '<span class="dot dot-ok"></span> SYSTEM ONLINE';
    } else {
        pill.className = "status-pill pill-error";
        pill.innerHTML = '<span class="dot dot-error"></span> SYSTEM OFFLINE';
    }

    // Grid connection status
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

    // SOC ring
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
    // Show which port the load is being read from
    const source = document.getElementById("load-source");
    if (source) {
        const gridConn = snapshot && snapshot.grid && snapshot.grid.connected;
        if (gridConn === false) {
            source.textContent = "Load Power (Backup port)";
        } else {
            source.textContent = "Load Power (Grid port)";
        }
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
    const s = snapshot.solar;
    const b = snapshot.battery;
    const g = snapshot.grid;
    const l = snapshot.load;

    // Power values available?
    const pvPower = s.power && s.power.state === "available" ? Number(s.power.value) : null;
    const battPower = b.power && b.power.state === "available" ? Number(b.power.value) : null;
    const gridPower = g.power && g.power.state === "available" ? Number(g.power.value) : null;
    const loadPower = l.power && l.power.state === "available" ? Number(l.power.value) : null;
    const battCurrent = b.current && b.current.state === "available" ? Number(b.current.value) : null;

    const gridConnected = snapshot.grid && snapshot.grid.connected;

    // Node values (only show when available)
    setValue("flow-solar-w", pvPower === null ? "--" : pvPower.toFixed(0) + " W");
    setValue("flow-load-w", loadPower === null ? "--" : loadPower.toFixed(0) + " W");
    // Solis S6-EH1P: positive battery power = CHARGING (power into battery),
    // negative = discharging (power out of battery).
    setValue("flow-batt-w", battPower === null ? "--"
        : (battPower > 0 ? "in " : "out ") + Math.abs(battPower).toFixed(0) + " W");
    // Grid node value: show connection state; power only when we have it.
    if (gridConnected === false) {
        setValue("flow-grid-w", "DISCONNECTED");
    } else if (gridPower === null) {
        setValue("flow-grid-w", "--");
    } else {
        setValue("flow-grid-w", (gridPower >= 0 ? "imp " : "exp ") + Math.abs(gridPower).toFixed(0) + " W");
    }
    // Inverter is the central hub — no value shown.

    // ---- Arrow directions ----
    // Solar -> Inverter: active when PV producing.
    setArrow("flow-solar-inv", pvPower !== null && pvPower > 0, "pv", "down");

    // Inverter -> Load: active when load consuming.
    setArrow("flow-inv-load", loadPower !== null && loadPower > 0, "load", "right");

    // Battery <-> Inverter direction.
    //   Solis S6-EH1P: positive battery power = CHARGING (inverter -> battery,
    //   arrow left pointing at the battery). Negative = DISCHARGING (battery ->
    //   inverter, arrow right pointing at the inverter icon).
    const battDir = battPower !== null ? Math.sign(battPower)
                  : (battCurrent !== null ? Math.sign(battCurrent) : 0);
    if (battDir > 0) {
        setArrow("flow-batt-inv", true, "batt", "left");     // charging: hub -> battery
    } else if (battDir < 0) {
        setArrow("flow-batt-inv", true, "batt", "right");    // discharging: battery -> hub
    } else {
        setArrow("flow-batt-inv", false, "batt", "hide");    // 0W -> no arrow
    }

    // Grid <-> Inverter: only show flow when grid is CONNECTED.
    //   Grid power (grid import/export) is not yet available from a
    //   verified register, so the arrow stays dim for now.
    if (gridConnected === true && gridPower !== null && gridPower > 0) {
        setArrow("flow-inv-grid", true, "grid", "up");       // import: grid -> hub
    } else if (gridConnected === true && gridPower !== null && gridPower < 0) {
        setArrow("flow-inv-grid", true, "grid", "down");     // export: hub -> grid
    } else {
        setArrow("flow-inv-grid", false, "grid", "up");
    }
}

function setArrow(id, active, colorClass, direction) {
    const el = document.getElementById(id);
    if (!el) return;
    const arrow = el.querySelector(".flow-arrow");
    if (!arrow) return;
    if (direction === "hide") {
        arrow.className = "flow-arrow hidden";
        return;
    }
    arrow.className = "flow-arrow " + direction;
    if (active) {
        arrow.classList.add("active", colorClass);
    }
}

function set(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

async function poll() {
    try {
        const snapshot = await fetchJSON("/api/status");
        lastGood = snapshot;
        updateStatusBanner(snapshot);
        updateSolar(snapshot.solar);
        updateBattery(snapshot.battery);
        updateGrid(snapshot.grid);
        updateLoad(snapshot.load, snapshot);
        updateEnergy(snapshot.energy);
        updateFlow(snapshot);
        updateGlobalStatus(snapshot);
        updateLastUpdate(snapshot);
    } catch (err) {
        // Network/server error — show offline but keep last good values.
        updateGlobalStatus(null);
        const pill = document.querySelector("#status-banner .status-pill");
        if (pill) {
            pill.className = "status-pill pill-error";
            pill.innerHTML = '<span class="dot dot-error"></span> CONNECTION LOST';
        }
    }
}

// Poll every 2 seconds.
poll();
setInterval(poll, 2000);

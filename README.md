# solis-monitor

Alternative monitoring software for the **Solis S6-EH1P6K-L-PLUS** hybrid
inverter, accessed via the **Solis S2-WL-ST** data logger over Modbus TCP.

## Communication Path

```
PC → 192.168.1.100:502 → S2-WL-ST → RS485 → S6-EH1P6K-L-PLUS
```

## Two Applications

### 1. Diagnostic tool (Phase 1, CLI)

```
python solis_diagnostic.py
```
or double-click `run_solis.bat`.

Reads verified registers and prints them to the console. Read-only.

### 2. Web Dashboard (Phase 2A, GUI)

```
python run_dashboard.py
```
or double-click `run_dashboard.bat`, then open **http://127.0.0.1:8080**

Pages:
- **Dashboard** — live cards (Solar, Battery, Grid, Load), energy-flow
  visualization, energy statistics
- **History** — charts of recorded data (PV power, load power, battery SOC,
  battery power) with ranges: Today / Yesterday / 7 Days / 30 Days / All
- **System** — system info, connection settings, register diagnostics table

## Data Logger (SQLite)

While the dashboard is running, a background thread records every poll
(one row per 3 seconds) to **`solis_history.db`** (SQLite, no extra
dependencies, built into Python). This gives you a usable historical
record starting immediately, without waiting for the full Phase 4
database work.

The database has a single `readings` table with columns:

`ts_unix, ts_iso, pv1_voltage, pv1_current, pv2_voltage, pv2_current,
pv_power, grid_voltage, grid_frequency, battery_voltage, battery_current,
battery_power, battery_soc, battery_soh, house_load, backup_load`

Rows with unavailable values store `NULL` (never fabricated).

The API exposes recorded data at `GET /api/history?limit=200` (returns
the most recent rows, newest first) for future History/charts use.

To view the data directly (e.g. from a terminal):

```
python -c "import sqlite3; c=sqlite3.connect('solis_history.db'); print(c.execute('SELECT ts_iso,pv_power,battery_soc,grid_voltage,house_load,backup_load FROM readings ORDER BY id DESC LIMIT 10').fetchall())"
```

## Architecture (4 layers)

```
Layer 4  GUI ............ dashboard_app/templates/ + static/
Layer 3  API ............ dashboard_app/api.py        (Flask JSON endpoints)
Layer 2  Normalization .. dashboard_app/normalize.py  (normalized snapshot)
Layer 1  Modbus ......... dashboard_app/modbus_layer.py (pymodbus poller)
```

- Layer 1 reads the verified registers on a background thread.
- Layer 2 converts raw registers into a **state-aware** snapshot
  (`available` / `unavailable` / `unverified` / `error`).
- Layer 3 exposes `GET /api/status`, `GET /api/diagnostics`, `GET /api/config`,
  and `GET /api/history`.
- The data logger (Layer 2 companion) writes each snapshot to SQLite.
- The GUI polls `/api/status` every 3 seconds and re-renders in place.

**No fabricated values.** Unverified registers render as `--`. Grid
disconnection is a normal state, not an error.

## Load Power (mode-dependent)

The S6-EH1P reports load on different registers depending on how the
system is operating:

- **On-grid:** `house_load` (33147) = consumption through the grid port
- **Off-grid (backup):** `backup_load` (33148) = consumption on the backup output

The dashboard's **Load Power** automatically shows the value matching the
current mode (the big number on the Load card). The two individual values
are always shown beneath it so you can see both. When off-grid, the Load
card label reads "Load Power (Backup port)".

## Energy Flow Diagram

The inverter is shown as the central hub connecting Solar, Battery, Load,
and Grid. The inverter itself displays no value — it is the junction, not
a measurement point. Arrows indicate direction only when the relevant
power data is available:

| Link | Arrow when active |
|------|-------------------|
| Solar → Inverter | PV power > 0 |
| Inverter → Load | Load power > 0 |
| Battery ↔ Inverter | discharging: battery → hub; charging: hub → battery |
| Grid ↔ Inverter | import: grid → hub (up); export: hub → grid (down) |

## Files

| File / Folder | Purpose |
|---------------|---------|
| `solis_diagnostic.py` | Phase 1 CLI diagnostic (kept) |
| `solis_verified_read.py` | Clean verified-register readout (kept) |
| `run_dashboard.py` | Web dashboard entry point |
| `dashboard_app/config.py` | Connection + app settings |
| `dashboard_app/registers.py` | **Single source of truth** for the register map |
| `dashboard_app/modbus_layer.py` | Layer 1: Modbus acquisition + poller |
| `dashboard_app/normalize.py` | Layer 2: normalized snapshot |
| `dashboard_app/api.py` | Layer 3: Flask API |
| `dashboard_app/data_logger.py` | SQLite history recorder (background thread) |
| `dashboard_app/templates/` | Layer 4: HTML pages |
| `dashboard_app/static/` | Layer 4: CSS + JS (incl. local Chart.js, works offline) |
| `archive/` | Temporary Phase 1 discovery scripts |
| `docs/` | Reference documentation |

## Verified Register Map (S6-EH1P, ESINV-33000ID protocol)

All registers use **Function 04 (Read Input Registers)**, no address offset.
Cross-validated against the inverter LCD on 2026-08-11.

| Register | Parameter | Type | Scale |
|----------|-----------|------|-------|
| 33049 | PV1 Voltage | U16 | x0.1 V |
| 33050 | PV1 Current | U16 | x0.1 A |
| 33051 | PV2 Voltage | U16 | x0.1 V |
| 33052 | PV2 Current | U16 | x0.1 A |
| 33057-58 | PV Power Total | U32 | x1 W |
| 33073 | Grid Voltage | U16 | x0.1 V |
| 33079-80 | AC Power | S32 | x1 W |
| 33094 | Grid Frequency | U16 | x0.01 Hz |
| 33133 | Battery Voltage | U16 | x0.1 V |
| 33134 | Battery Current | S16 | x0.1 A |
| 33139 | Battery SOC | U16 | x1 % |
| 33140 | Battery SOH | U16 | x1 % |
| 33141 | BMS Voltage | U16 | x0.01 V |
| 33147 | House Load | U16 | x1 W |
| 33148 | Backup Load | U16 | x1 W |
| 33149-50 | Battery Power | S32 | x1 W |

## DEMO Mode

For UI development without touching the inverter, set `DEMO_MODE = True`
in `dashboard_app/config.py`. The API then returns clearly-labeled mock data
and the dashboard shows a **DEMO DATA** badge. Never enable for production.

## Project Phases

1. **Phase 1 (DONE):** Communication and Modbus verification
2. **Phase 2A (IN PROGRESS):** Graphical interface (layered architecture)
3. **Phase 2B:** Reliable inverter data acquisition
4. **Phase 3:** Data normalization and decoding (partial in 2A)
5. **Phase 4:** Local database and historical data
6. **Phase 5:** Backend/API (partial in 2A)
7. **Phase 6:** Web dashboard (partial in 2A)
8. **Phase 7:** Charts and historical analytics
9. **Phase 8:** Alerts and notifications
10. **Phase 9:** Authentication and secure remote access
11. **Phase 10:** Optional advanced features

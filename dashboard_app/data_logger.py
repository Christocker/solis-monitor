"""
DATA LOGGER (Phase 4 prelude).

Records the normalized inverter snapshot to a local SQLite database
so historical data is available for the History page and analytics.

Design:
  - Uses the SAME normalized snapshot the API serves (normalize.build_snapshot).
  - Runs on a background thread, one row per poll interval.
  - Writes are batched per poll and committed once, so disk writes are small.
  - Never blocks the Modbus poller or the web server.

Schema: table "readings" — one column per available field, plus a
UNIX timestamp and ISO timestamp.
"""

import os
import sqlite3
import threading
import time

from . import modbus_layer
from . import normalize
from .config import POLL_INTERVAL

# Database file lives next to the app (project root).
DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "solis_history.db")

# Columns stored for every reading.
# key -> (column_name, converter)
FIELDS = [
    # (snapshot key path, column name)
    ("pv1_voltage", "pv1_voltage"),
    ("pv1_current", "pv1_current"),
    ("pv2_voltage", "pv2_voltage"),
    ("pv2_current", "pv2_current"),
    ("pv_power_total", "pv_power"),
    ("grid_voltage", "grid_voltage"),
    ("grid_frequency", "grid_frequency"),
    ("battery_voltage", "battery_voltage"),
    ("battery_current", "battery_current"),
    ("battery_power", "battery_power"),
    ("battery_soc", "battery_soc"),
    ("battery_soh", "battery_soh"),
    ("house_load", "house_load"),
    ("backup_load", "backup_load"),
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts_unix REAL NOT NULL,
    ts_iso TEXT NOT NULL,
    {columns}
);
CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings(ts_unix);
"""


def _col_decl(name):
    return f"{name} REAL"


class DataLogger:
    """Background logger writing one row per poll to SQLite."""

    def __init__(self, db_path=DB_PATH, poll_interval=POLL_INTERVAL):
        self.db_path = db_path
        self.poll_interval = poll_interval
        self._stop_event = threading.Event()
        self._thread = None
        self._lock = threading.Lock()
        self._last_row_count = 0

        cols = ", ".join(_col_decl(c) for _, c in FIELDS)
        self._insert_sql = (
            "INSERT INTO readings (ts_unix, ts_iso, "
            + ", ".join(c for _, c in FIELDS)
            + ") VALUES (?, ?, "
            + ", ".join("?" for _ in FIELDS)
            + ")"
        )

    # ------------------------------------------------------------------
    def _connect(self):
        conn = sqlite3.connect(self.db_path)
        conn.executescript(SCHEMA.format(columns=cols_schema()))
        conn.commit()
        return conn

    def _init_db(self):
        self._connect().close()

    def _insert(self, conn, row):
        conn.execute(self._insert_sql, row)

    # ------------------------------------------------------------------
    def _record_cycle(self):
        """Build one row from the current snapshot and store it."""
        raw, errors = modbus_layer.reader.get_raw_snapshot()
        identification = modbus_layer.reader.get_identification()
        snapshot = normalize.build_snapshot(raw, errors, identification)

        now = time.time()
        ts_iso = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now))

        row = [now, ts_iso]

        # Map each field from the snapshot.
        for snap_key, _col in FIELDS:
            # snap_key is a top-level snapshot category field name
            # e.g. pv1_voltage lives under snapshot["solar"]
            value = _extract(snapshot, snap_key)
            row.append(value)

        conn = self._connect()
        try:
            self._insert(conn, row)
            conn.commit()
            with self._lock:
                self._last_row_count += 1
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    # ------------------------------------------------------------------
    def _poll_loop(self):
        while not self._stop_event.wait(self.poll_interval):
            try:
                self._record_cycle()
            except Exception as exc:
                print(f"[data_logger] write failed: {exc}")

    def start(self):
        self._init_db()
        if self._thread is not None and self._thread.is_alive():
            return
        self._thread = threading.Thread(
            target=self._poll_loop, daemon=True, name="data-logger"
        )
        self._thread.start()

    def stop(self):
        self._stop_event.set()

    # ------------------------------------------------------------------
    def row_count(self):
        with self._lock:
            return self._last_row_count

    def query(self, limit=100):
        """Return the most recent rows (for debugging/preview), newest first.

        Row layout: ts_iso, ts_unix, then one value per FIELDS column (in order).
        """
        cols = ", ".join(c for _, c in FIELDS)
        conn = self._connect()
        try:
            cur = conn.execute(
                f"SELECT ts_iso, ts_unix, {cols} FROM readings ORDER BY id DESC LIMIT ?",
                (limit,),
            )
            rows = cur.fetchall()
        finally:
            conn.close()
        return rows

    def query_range(self, start_unix, end_unix, columns=None, limit=None):
        """Return rows within a UNIX time window, oldest first.

        columns: optional list of column names (from FIELDS). Default = all.
        limit:   optional cap; keeps the most recent `limit` rows in the window.
        """
        cols = columns or [c for _, c in FIELDS]
        col_sql = ", ".join(cols)
        conn = self._connect()
        try:
            if limit:
                cur = conn.execute(
                    f"SELECT ts_unix, ts_iso, {col_sql} FROM readings "
                    "WHERE ts_unix >= ? AND ts_unix <= ? "
                    "ORDER BY ts_unix DESC LIMIT ?",
                    (start_unix, end_unix, int(limit)),
                )
                rows = cur.fetchall()
                rows.reverse()
            else:
                cur = conn.execute(
                    f"SELECT ts_unix, ts_iso, {col_sql} FROM readings "
                    "WHERE ts_unix >= ? AND ts_unix <= ? ORDER BY ts_unix ASC",
                    (start_unix, end_unix),
                )
                rows = cur.fetchall()
        finally:
            conn.close()
        return rows

    def energy_summary(self, start_unix, end_unix, max_gap=300.0):
        """Integrate power over time to get energy (kWh) for a time range.

        Returns a dict:
            solar, consumption, battery_charge, battery_discharge  (kWh, floats)
            samples   : number of raw rows in the range
        Consumption is house_load + backup_load (the two ports are used in
        different modes). Intervals longer than `max_gap` seconds are skipped
        so missing data never fabricates energy.
        """
        conn = self._connect()
        try:
            cur = conn.execute(
                "SELECT ts_unix, pv_power, battery_power, house_load, backup_load "
                "FROM readings WHERE ts_unix >= ? AND ts_unix <= ? "
                "ORDER BY ts_unix ASC",
                (start_unix, end_unix),
            )
            rows = cur.fetchall()
        finally:
            conn.close()

        solar = consumption = charge = discharge = 0.0
        prev = None
        for ts, pv, batt, house, backup in rows:
            load = None
            if house is not None or backup is not None:
                load = (house or 0.0) + (backup or 0.0)
            if prev is not None:
                dt = ts - prev[0]
                if 0 < dt <= max_gap:
                    if prev[1] is not None and pv is not None:
                        solar += (prev[1] + pv) / 2.0 * dt
                    if prev[2] is not None and batt is not None:
                        e = (prev[2] + batt) / 2.0 * dt
                        if e > 0:
                            discharge += e
                        else:
                            charge += -e
                    if prev[3] is not None and load is not None:
                        consumption += (prev[3] + load) / 2.0 * dt
            prev = (ts, pv, batt, load)

        kwh = 3_600_000.0
        return {
            "solar": solar / kwh,
            "consumption": consumption / kwh,
            "battery_charge": charge / kwh,
            "battery_discharge": discharge / kwh,
            "samples": len(rows),
        }

    def query_buckets(self, start_unix=None, end_unix=None, buckets=240):
        """Aggregate readings into `buckets` time buckets, oldest first.

        Returns one dict per non-empty bucket with averaged columns (the
        same column names as the raw rows) plus:
            bucket_ts    : timestamp of the first sample in the bucket
            ts_unix      : alias of bucket_ts (so the charts can reuse rows)
            samples      : number of raw rows in the bucket
            bucket_width : nominal width of the bucket in seconds
            grid_seconds : grid-connected seconds actually covered by the
                           samples in this bucket (fraction x coverage)
            pv_power_max : peak PV power within the bucket

        If start/end are omitted the full recorded range is used, so the
        History page can show everything from the first record to now.
        """
        buckets = max(1, int(buckets))
        conn = self._connect()
        try:
            if start_unix is None or end_unix is None:
                lo, hi = conn.execute(
                    "SELECT MIN(ts_unix), MAX(ts_unix) FROM readings"
                ).fetchone()
                if lo is None:
                    return []
                if start_unix is None:
                    start_unix = lo
                if end_unix is None:
                    end_unix = hi

            span = float(end_unix) - float(start_unix)
            if span <= 0:
                span = 1.0
            width = span / buckets

            cols = [c for _, c in FIELDS]
            avg_cols = ", ".join(f"AVG({c}) AS {c}" for c in cols)
            # grid_seconds = connected fraction x the time actually covered by
            # the bucket's samples (span + one sample interval), so short or
            # partial buckets are not credited a full nominal width.
            coverage = (
                "(MAX(ts_unix) - MIN(ts_unix)) * "
                "(CASE WHEN COUNT(*) > 1 THEN COUNT(*) * 1.0 / (COUNT(*) - 1) "
                "ELSE 0 END)"
            )
            sql = (
                "SELECT MIN(ts_unix) AS bucket_ts, "
                "COUNT(*) AS samples, "
                f"AVG(CASE WHEN grid_voltage >= 50 THEN 1.0 ELSE 0.0 END) * {coverage} "
                "AS grid_seconds, "
                "? AS bucket_width, "
                f"{avg_cols}, MAX(pv_power) AS pv_power_max "
                "FROM readings "
                "WHERE ts_unix >= ? AND ts_unix <= ? "
                "GROUP BY MIN(CAST((ts_unix - ?) / ? AS INTEGER), ?) "
                "ORDER BY bucket_ts"
            )
            cur = conn.execute(
                sql, (width, start_unix, end_unix, start_unix, width, buckets - 1)
            )
            names = ["bucket_ts", "samples", "grid_seconds", "bucket_width",
                     *cols, "pv_power_max"]
            rows = []
            for r in cur.fetchall():
                row = dict(zip(names, r))
                row["ts_unix"] = row["bucket_ts"]
                rows.append(row)
            return rows
        finally:
            conn.close()

    def min_max_time(self):
        """Return (first_ts, last_ts) recorded in the database, or None."""
        conn = self._connect()
        try:
            cur = conn.execute("SELECT MIN(ts_unix), MAX(ts_unix) FROM readings")
            return cur.fetchone()
        finally:
            conn.close()

    def count(self):
        """Return total number of rows."""
        conn = self._connect()
        try:
            cur = conn.execute("SELECT COUNT(*) FROM readings")
            return cur.fetchone()[0]
        finally:
            conn.close()


def _extract(snapshot, field_name):
    """Extract a scalar value from the snapshot for a given field key.

    FIELDS uses short keys that map to nested snapshot locations.
    """
    # Map short key -> (category, key)
    cat_map = {
        "pv1_voltage": ("solar", "pv1_voltage"),
        "pv1_current": ("solar", "pv1_current"),
        "pv2_voltage": ("solar", "pv2_voltage"),
        "pv2_current": ("solar", "pv2_current"),
        "pv_power_total": ("solar", "power"),
        "grid_voltage": ("grid", "voltage"),
        "grid_frequency": ("grid", "frequency"),
        "battery_voltage": ("battery", "voltage"),
        "battery_current": ("battery", "current"),
        "battery_power": ("battery", "power"),
        "battery_soc": ("battery", "soc"),
        "battery_soh": ("battery", "soh"),
        "house_load": ("load", "house_load"),
        "backup_load": ("load", "backup_power"),
    }
    if field_name not in cat_map:
        return None
    cat, key = cat_map[field_name]
    field = snapshot.get(cat, {}).get(key)
    if field is None:
        return None
    if field.get("state") != "available":
        return None
    return field.get("value")


def cols_schema():
    return ", ".join(_col_decl(c) for _, c in FIELDS)


# Shared logger instance.
logger = DataLogger()


def start_logger():
    """Start the shared data logger (idempotent)."""
    from .config import DEMO_MODE
    if DEMO_MODE:
        return
    logger.start()

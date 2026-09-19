"""
LAYER 3: APPLICATION / API LAYER.

Responsibility:
  - Expose the normalized snapshot to the GUI over HTTP (JSON).
  - Serve the web pages and static assets.
  - Report diagnostics (register table + stats).

This layer never talks to Modbus directly; it consumes Layer 1 raw data
via Layer 2 normalization.
"""

import math
import time

from flask import jsonify, render_template, request
from werkzeug.exceptions import HTTPException

from .config import (
    DEMO_MODE, SERVER_HOST, SERVER_PORT, POLL_INTERVAL, CONFIG,
    CO2_KG_PER_KWH, CO2_KG_PER_TREE_YEAR,
)
from . import modbus_layer
from . import normalize
from . import data_logger
from . import cloud_sync


# --- Today's energy totals (integrated from recorded readings) ---
_ENERGY_CACHE_SECONDS = 20.0
_energy_cache = {"t": 0.0, "fields": None}


def _start_of_today():
    lt = time.localtime()
    return time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))


def _energy_field(name, value):
    if value is None:
        return {"name": name, "value": None, "state": "unavailable", "unit": "kWh"}
    return {"name": name, "value": round(value, 3), "state": "available", "unit": "kWh"}


def _today_energy_fields():
    """Today's energy totals, computed from recorded readings (cached ~20s)."""
    now = time.time()
    if (_energy_cache["fields"] is not None
            and now - _energy_cache["t"] < _ENERGY_CACHE_SECONDS):
        return _energy_cache["fields"]
    try:
        summary = data_logger.logger.energy_summary(_start_of_today(), now)
    except Exception:
        summary = {}
    has_data = bool(summary.get("intervals"))
    val = lambda key: (summary.get(key) if has_data else None)
    fields = {
        "today_solar": _energy_field("Today's Solar Generation", val("solar")),
        "today_consumption": _energy_field("Today's Consumption", val("consumption")),
        "today_battery_charge": _energy_field("Today's Battery Charged",
                                              val("battery_charge")),
        "today_battery_discharge": _energy_field("Today's Battery Discharged",
                                                 val("battery_discharge")),
        # This inverter has no dedicated grid import/export meter.
        "grid_import": _energy_field("Grid Import", None),
        "grid_export": _energy_field("Grid Export", None),
    }
    _energy_cache["t"] = now
    _energy_cache["fields"] = fields
    return fields


# --- Lifetime totals (whole recorded history) ---
_LIFETIME_CACHE_SECONDS = 300.0
_lifetime_cache = {"t": 0.0, "fields": None}


def _co2_field(name, kwh):
    """CO2 avoided estimate (kg) from generated kWh, plus a tree-year equivalent."""
    if kwh is None:
        return {"name": name, "value": None, "state": "unavailable",
                "unit": "kg", "trees": None}
    co2 = kwh * CO2_KG_PER_KWH
    return {
        "name": name,
        "value": round(co2, 1),
        "state": "available",
        "unit": "kg",
        "trees": round(co2 / CO2_KG_PER_TREE_YEAR, 1),
    }


def _lifetime_energy_fields():
    """Lifetime energy totals, integrated from every recorded reading (cached)."""
    now = time.time()
    if (_lifetime_cache["fields"] is not None
            and now - _lifetime_cache["t"] < _LIFETIME_CACHE_SECONDS):
        return _lifetime_cache["fields"]
    first, _last = data_logger.logger.min_max_time()
    summary = {}
    if first is not None:
        try:
            summary = data_logger.logger.energy_summary(first, now)
        except Exception:
            summary = {}
    has = bool(summary.get("intervals"))
    val = lambda key: (summary.get(key) if has else None)
    fields = {
        "lifetime_solar": _energy_field("Lifetime Solar Generation", val("solar")),
        "lifetime_consumption": _energy_field("Lifetime Consumption", val("consumption")),
        "lifetime_battery_charge": _energy_field("Lifetime Battery Charged",
                                                 val("battery_charge")),
        "lifetime_battery_discharge": _energy_field("Lifetime Battery Discharged",
                                                    val("battery_discharge")),
        "co2_avoided": _co2_field("CO2 Avoided", val("solar")),
        "first_record": first,
    }
    _lifetime_cache["t"] = now
    _lifetime_cache["fields"] = fields
    return fields


def _current_snapshot():
    """Return the latest normalized snapshot."""
    if DEMO_MODE:
        raw, errors = modbus_layer.build_demo_snapshot()
        identification = {
            "serial_number": [0x3130, 0x3331, 0x3733, 0x3032, 0x3541, 0x3237, 0x3130, 0x3335],
            "inverter_type": [0x2190],
            "product_model": [0x3173],
            "dsp_version": [21],
            "hmi_version": [41],
        }
        stats = {}
    else:
        raw, errors = modbus_layer.reader.get_raw_snapshot()
        identification = modbus_layer.reader.get_identification()
        stats = modbus_layer.reader.get_stats()

    snapshot = normalize.build_snapshot(raw, errors, identification)

    # Honesty: report the data's own timestamp and derive "online" from
    # freshness, so a dead poller cannot keep claiming SYSTEM ONLINE.
    now = time.time()
    last = stats.get("last_success_time")
    stale_after = max(3 * POLL_INTERVAL, 10.0)
    age = (now - last) if last is not None else None
    fresh = age is not None and age <= stale_after
    data_ts = last if last is not None else now

    system = snapshot.get("system", {})
    system["online"] = bool(fresh and system.get("online"))
    system["stale"] = (age is None) or (age > stale_after)
    system["age_seconds"] = round(age, 1) if age is not None else None
    iso = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(data_ts))
    system["last_update"] = iso
    snapshot["system"] = system
    snapshot["timestamp"] = iso

    snapshot["stats"] = {
        "last_success_time": last,
        "last_error_time": stats.get("last_error_time"),
        "last_error_message": stats.get("last_error_message"),
        "read_errors": stats.get("read_errors", 0),
        "connection_errors": stats.get("connection_errors", 0),
        "total_reads": stats.get("total_reads", 0),
        "stale": system["stale"],
        "age_seconds": system["age_seconds"],
    }
    energy = _today_energy_fields()
    energy.update(_lifetime_energy_fields())
    snapshot["energy"] = energy
    return snapshot


def _current_diagnostics():
    if DEMO_MODE:
        raw, errors = modbus_layer.build_demo_snapshot()
        stats = {
            "connection_errors": 0,
            "read_errors": 0,
            "total_reads": 0,
            "last_success_time": None,
            "last_error_time": None,
            "last_error_message": None,
        }
    else:
        raw, errors = modbus_layer.reader.get_raw_snapshot()
        stats = modbus_layer.reader.get_stats()
    return normalize.build_diagnostics_snapshot(raw, errors, stats)


def create_app():
    """Application factory."""
    from flask import Flask
    app = Flask(__name__)
    app.config["DEMO_MODE"] = DEMO_MODE

    @app.errorhandler(Exception)
    def _handle_error(e):
        """Always answer API/browser errors as JSON, never a bare HTML 500."""
        if isinstance(e, HTTPException):
            return jsonify({"error": e.name}), (e.code or 500)
        app.logger.exception("unhandled error")
        return jsonify({"error": str(e)}), 500

    @app.route("/")
    def dashboard():
        return render_template("dashboard.html")

    @app.route("/history")
    def history():
        return render_template("history.html")

    @app.route("/system")
    def system():
        return render_template("system.html")

    @app.route("/api/status")
    def api_status():
        return jsonify(_current_snapshot())

    @app.route("/api/diagnostics")
    def api_diagnostics():
        return jsonify(_current_diagnostics())

    @app.route("/api/config")
    def api_config():
        return jsonify({
            "host": CONFIG["host"],
            "port": CONFIG["port"],
            "slave_id": CONFIG["slave_id"],
            "timeout": CONFIG["timeout"],
            "poll_interval": POLL_INTERVAL,
            "demo_mode": DEMO_MODE,
            "server_host": SERVER_HOST,
            "server_port": SERVER_PORT,
        })

    @app.route("/api/history")
    def api_history():
        """Return recorded rows from the SQLite history database.

        Query params:
          limit : max rows (default 200, max 10000)
          start : UNIX timestamp (optional) — inclusive
          end   : UNIX timestamp (optional) — inclusive
        Returns rows oldest-first when a range is given, newest-first otherwise.
        """
        limit = request.args.get("limit", default=200, type=int)
        limit = max(1, min(limit, 10000))
        start = request.args.get("start", default=None, type=float)
        end = request.args.get("end", default=None, type=float)
        if start is not None and not math.isfinite(start):
            return jsonify({"error": "start must be a finite number"}), 400
        if end is not None and not math.isfinite(end):
            return jsonify({"error": "end must be a finite number"}), 400
        if start is not None and end is not None and start > end:
            return jsonify({"error": "start must be <= end"}), 400

        columns = [
            "pv1_voltage", "pv1_current", "pv2_voltage", "pv2_current",
            "pv_power", "grid_voltage", "grid_frequency",
            "battery_voltage", "battery_current", "battery_power",
            "battery_soc", "battery_soh", "house_load", "backup_load",
        ]

        if start is not None or end is not None:
            # Honour a single bound too, and keep at most `limit` rows
            # (the most recent ones within the window).
            lo = start if start is not None else 0.0
            hi = end if end is not None else 9.9e12
            rows = data_logger.logger.query_range(
                lo, hi, columns=columns, limit=limit
            )
            rows_out = [
                {"ts": r[1], "ts_unix": r[0],
                 **dict(zip(columns, r[2:]))}
                for r in rows
            ]
        else:
            recent = data_logger.logger.query(limit=limit)
            rows_out = [
                {
                    "ts": r[0],
                    "ts_unix": r[1],
                    "pv1_voltage": r[2],
                    "pv1_current": r[3],
                    "pv2_voltage": r[4],
                    "pv2_current": r[5],
                    "pv_power": r[6],
                    "grid_voltage": r[7],
                    "grid_frequency": r[8],
                    "battery_voltage": r[9],
                    "battery_current": r[10],
                    "battery_power": r[11],
                    "battery_soc": r[12],
                    "battery_soh": r[13],
                    "house_load": r[14],
                    "backup_load": r[15],
                }
                for r in recent
            ]

        return jsonify({"count": len(rows_out), "rows": rows_out})

    @app.route("/api/history/meta")
    def api_history_meta():
        """Return metadata about the history database."""
        min_t, max_t = data_logger.logger.min_max_time()
        return jsonify({
            "first_ts": min_t,
            "last_ts": max_t,
            "total_rows": data_logger.logger.count(),
        })

    @app.route("/api/history/buckets")
    def api_history_buckets():
        """Downsampled history for full-range charts.

        Query params:
          buckets : number of time buckets (default 240, max 2000)
          start   : UNIX timestamp (optional) — default = first record
          end     : UNIX timestamp (optional) — default = latest record
        Returns one aggregated row per non-empty bucket, oldest first.
        """
        buckets = request.args.get("buckets", default=240, type=int)
        buckets = max(1, min(buckets, 2000))
        start = request.args.get("start", default=None, type=float)
        end = request.args.get("end", default=None, type=float)
        if start is not None and not math.isfinite(start):
            return jsonify({"error": "start must be a finite number"}), 400
        if end is not None and not math.isfinite(end):
            return jsonify({"error": "end must be a finite number"}), 400
        if start is not None and end is not None and start > end:
            return jsonify({"error": "start must be <= end"}), 400
        rows = data_logger.logger.query_buckets(start, end, buckets)
        return jsonify({"count": len(rows), "rows": rows})

    # Start the background poller and data logger when the app is created.
    modbus_layer.start_poller()
    data_logger.start_logger()
    # Reuse the dashboard's Modbus connection for the cloud sync
    # (the S2-WL-ST logger allows only ONE connection at a time).
    if not DEMO_MODE:
        cloud_sync.start_syncer(modbus_layer.reader)

    return app

"""
LAYER 3: APPLICATION / API LAYER.

Responsibility:
  - Expose the normalized snapshot to the GUI over HTTP (JSON).
  - Serve the web pages and static assets.
  - Report diagnostics (register table + stats).

This layer never talks to Modbus directly; it consumes Layer 1 raw data
via Layer 2 normalization.
"""

from flask import jsonify, render_template, request

from .config import DEMO_MODE, SERVER_HOST, SERVER_PORT, POLL_INTERVAL, CONFIG
from . import modbus_layer
from . import normalize
from . import data_logger


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
    else:
        raw, errors = modbus_layer.reader.get_raw_snapshot()
        identification = modbus_layer.reader.get_identification()
    return normalize.build_snapshot(raw, errors, identification)


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

        columns = [
            "pv1_voltage", "pv1_current", "pv2_voltage", "pv2_current",
            "pv_power", "grid_voltage", "grid_frequency",
            "battery_voltage", "battery_current", "battery_power",
            "battery_soc", "battery_soh", "house_load", "backup_load",
        ]

        if start is not None and end is not None:
            rows = data_logger.logger.query_range(start, end, columns=columns)
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
                    "pv_power": r[1],
                    "battery_soc": r[2],
                    "grid_voltage": r[3],
                    "house_load": r[4],
                    "backup_load": r[5],
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

    # Start the background poller and data logger when the app is created.
    modbus_layer.start_poller()
    data_logger.start_logger()

    return app

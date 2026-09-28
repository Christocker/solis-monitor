"""
CLOUD SYNC (integrated into the dashboard process).

Reads the shared Modbus snapshot (the dashboard's own Modbus connection)
and pushes it to a Supabase cloud database every ~2 seconds, so the
Vercel-hosted website can show live data from anywhere.

This module is used in two ways:
  1. Standalone (repo root cloud_sync.py) with its own ModbusReader.
  2. Integrated (dashboard_app/api.py) reusing the dashboard's shared
     reader, because the S2-WL-ST logger allows only ONE Modbus TCP
     connection at a time.

The sync itself is STRICTLY READ-ONLY toward the inverter.
"""

import json
import os
import socket
import threading
import time

import requests

from .config import CONFIG
from . import normalize

# How often to push a reading to the cloud (seconds).
SYNC_INTERVAL = 2.0

# Column names for the Supabase "readings" table (match the SQLite logger).
READINGS_COLUMNS = [
    "pv1_voltage", "pv1_current", "pv2_voltage", "pv2_current",
    "pv_power", "grid_voltage", "grid_frequency",
    "battery_voltage", "battery_current", "battery_power",
    "battery_soc", "battery_soh", "house_load", "backup_load",
]

# Map snapshot field -> (category, key)
SNAPSHOT_MAP = {
    "pv1_voltage": ("solar", "pv1_voltage"),
    "pv1_current": ("solar", "pv1_current"),
    "pv2_voltage": ("solar", "pv2_voltage"),
    "pv2_current": ("solar", "pv2_current"),
    "pv_power": ("solar", "power"),
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


def load_env():
    """Load a .env file if present (simple KEY=VALUE lines)."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")
    if not os.path.exists(path):
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def get_credentials():
    """Return (url, key) from env, or (None, None) if missing."""
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    return (url or None), (key or None)


def supabase_post(table, payload, url, key):
    """Insert a row (or rows) into a Supabase table via PostgREST."""
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    resp = requests.post(
        f"{url}/rest/v1/{table}", headers=headers,
        data=json.dumps(payload), timeout=10,
    )
    resp.raise_for_status()
    return resp


def build_row(snapshot):
    """Build a single DB row from the normalized snapshot."""
    row = {}
    for col in READINGS_COLUMNS:
        cat, key = SNAPSHOT_MAP[col]
        field = snapshot.get(cat, {}).get(key)
        if field and field.get("state") == "available" and field.get("value") is not None:
            row[col] = field["value"]
        else:
            row[col] = None
    return row


def sync_system_info(snapshot, url, key):
    """Write the system identity row once (serial, model, protocol)."""
    sys = snapshot.get("system", {})
    product = sys.get("product_model", {}).get("value")
    row = {
        "id": 1,
        "serial_number": sys.get("serial_number", {}).get("value"),
        "inverter_model": sys.get("inverter_model", {}).get("value"),
        "protocol_version": sys.get("protocol_version", {}).get("value"),
        # product_model is an INTEGER column in Supabase
        "product_model": int(product) if product is not None else None,
    }
    # Upsert: insert or update row with id=1
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    resp = requests.post(
        f"{url}/rest/v1/system_info?on_conflict=id",
        headers=headers, data=json.dumps([row]), timeout=10,
    )
    resp.raise_for_status()
    return resp


def supabase_upsert(table, rows, url, key, on_conflict=None):
    """Insert or update rows (PostgREST upsert)."""
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    endpoint = f"{url}/rest/v1/{table}"
    if on_conflict:
        endpoint += f"?on_conflict={on_conflict}"
    resp = requests.post(endpoint, headers=headers, data=json.dumps(rows), timeout=10)
    resp.raise_for_status()
    return resp


# How often to write the heartbeat / daily-energy rollups (seconds).
HEARTBEAT_INTERVAL = 60.0
ENERGY_INTERVAL = 300.0


class CloudSyncer:
    """Background thread that pushes the shared reader's snapshot to Supabase."""

    def __init__(self, reader, interval=SYNC_INTERVAL):
        self._reader = reader
        self._interval = interval
        self._stop_event = threading.Event()
        self._thread = None
        self._url, self._key = get_credentials()
        # Health / heartbeat state
        self._last_ok = None
        self._errors = 0
        self._last_error = None
        self._last_heartbeat = 0.0
        self._last_energy = 0.0

    @property
    def configured(self):
        return bool(self._url and self._key)

    def start(self):
        if self._thread is not None and self._thread.is_alive():
            return
        if not self.configured:
            print(" WARNING: Cloud sync disabled - SUPABASE_URL / "
                  "SUPABASE_SERVICE_KEY not set (see .env.example).")
            return
        self._thread = threading.Thread(
            target=self._loop, daemon=True, name="cloud-sync"
        )
        self._thread.start()

    def get_status(self):
        """Health snapshot for the local API / UI."""
        now = time.time()
        return {
            "configured": self.configured,
            "last_sync_unix": self._last_ok,
            "age_seconds": round(now - self._last_ok, 1) if self._last_ok else None,
            "error_count": self._errors,
            "last_error": self._last_error,
        }

    def _maybe_heartbeat(self):
        now = time.time()
        if now - self._last_heartbeat < HEARTBEAT_INTERVAL:
            return
        self._last_heartbeat = now
        try:
            supabase_upsert("sync_status", [{
                "id": 1,
                "laptop_host": socket.gethostname(),
                "last_sync_unix": self._last_ok,
                "last_sync_iso": time.strftime(
                    "%Y-%m-%d %H:%M:%S",
                    time.localtime(self._last_ok or now)),
                "last_error": self._last_error,
                "error_count": self._errors,
                "active_alerts": self._active_alerts(),
            }], self._url, self._key, on_conflict="id")
        except requests.RequestException:
            pass          # heartbeat is best-effort

    @staticmethod
    def _active_alerts():
        try:
            from . import alerts
            return alerts.active_alerts()
        except Exception:
            return []

    def _maybe_energy(self):
        now = time.time()
        if now - self._last_energy < ENERGY_INTERVAL:
            return
        self._last_energy = now
        try:
            from . import data_logger
            rows = []
            for offset in (0, 1):
                lt = time.localtime(now - offset * 86400)
                start = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday,
                                     0, 0, 0, 0, 0, -1))
                end = now if offset == 0 else start + 86400
                summ = data_logger.logger.energy_summary(start, end)
                if not summ.get("intervals"):
                    continue
                rows.append({
                    "day": time.strftime("%Y-%m-%d", time.localtime(start)),
                    "solar_kwh": round(summ["solar"], 3),
                    "consumption_kwh": round(summ["consumption"], 3),
                    "battery_charge_kwh": round(summ["battery_charge"], 3),
                    "battery_discharge_kwh": round(summ["battery_discharge"], 3),
                    "grid_import_kwh": round(summ["grid_import"], 3),
                    "grid_export_kwh": round(summ["grid_export"], 3),
                    "samples": summ["samples"],
                })
            if rows:
                supabase_upsert("daily_energy", rows, self._url, self._key,
                                on_conflict="day")
        except Exception as exc:
            self._last_error = str(exc)

    def stop(self):
        self._stop_event.set()

    def _loop(self):
        sync_started = False
        next_tick = time.monotonic()
        while not self._stop_event.is_set():
            next_tick += self._interval
            try:
                raw, errors = self._reader.get_raw_snapshot()
                identification = self._reader.get_identification()
                snapshot = normalize.build_snapshot(raw, errors, identification)

                if not sync_started:
                    serial = snapshot.get("system", {}).get("serial_number", {}).get("value")
                    if serial:
                        sync_system_info(snapshot, self._url, self._key)
                        sync_started = True
                        print(" Cloud sync: system identity synced.")

                row = build_row(snapshot)
                row["ts_unix"] = time.time()
                row["ts_iso"] = time.strftime(
                    "%Y-%m-%d %H:%M:%S", time.localtime(row["ts_unix"])
                )

                supabase_post("readings", [row], self._url, self._key)
                self._last_ok = row["ts_unix"]
                self._errors = 0
                self._last_error = None

            except requests.RequestException as exc:
                self._errors += 1
                self._last_error = str(exc)
                print(f"  ! cloud sync upload failed: {exc}")
            except Exception as exc:
                self._errors += 1
                self._last_error = str(exc)
                print(f"  ! cloud sync error: {type(exc).__name__}: {exc}")

            self._maybe_heartbeat()
            self._maybe_energy()

            # Sleep only the remainder of the interval so the upload
            # cadence stays exactly SYNC_INTERVAL (not interval + upload time).
            delay = next_tick - time.monotonic()
            if delay > 0:
                self._stop_event.wait(delay)


# Single shared syncer instance used by the dashboard app.
syncer = CloudSyncer(None)


def start_syncer(reader):
    """Start the shared cloud syncer against the given reader (idempotent)."""
    load_env()
    syncer._reader = reader
    syncer._url, syncer._key = get_credentials()
    syncer.start()

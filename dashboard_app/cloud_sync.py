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


class CloudSyncer:
    """Background thread that pushes the shared reader's snapshot to Supabase."""

    def __init__(self, reader, interval=SYNC_INTERVAL):
        self._reader = reader
        self._interval = interval
        self._stop_event = threading.Event()
        self._thread = None
        self._url, self._key = get_credentials()

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

    def stop(self):
        self._stop_event.set()

    def _loop(self):
        sync_started = False
        while not self._stop_event.is_set():
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
                print(f"  [{row['ts_iso']}] pv={row['pv_power']} "
                      f"soc={row['battery_soc']} grid={row['grid_voltage']} "
                      f"load={row['house_load'] or row['backup_load']}")

            except requests.RequestException as exc:
                print(f"  ! cloud sync upload failed: {exc}")
            except Exception as exc:
                print(f"  ! cloud sync error: {type(exc).__name__}: {exc}")

            self._stop_event.wait(self._interval)


# Single shared syncer instance used by the dashboard app.
syncer = CloudSyncer(None)


def start_syncer(reader):
    """Start the shared cloud syncer against the given reader (idempotent)."""
    load_env()
    syncer._reader = reader
    syncer._url, syncer._key = get_credentials()
    syncer.start()

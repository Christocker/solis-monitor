"""
CLOUD SYNCER (runs on the always-on server laptop).

Reads the live inverter snapshot (via the existing Modbus reader) and
pushes it to a Supabase cloud database every ~2 seconds, so the
Vercel-hosted website can show live data from anywhere.

Data flow:
    Inverter -> S2-WL-ST -> [this laptop: Modbus reader] -> Supabase
    -> Vercel website -> anyone online

Requirements:
    pip install -r requirements.txt

Configuration (environment variables):
    SUPABASE_URL            e.g. https://abcdefgh.supabase.co
    SUPABASE_SERVICE_KEY    the "service_role" key (server-side only,
                            never expose to the website)

Run:
    python cloud_sync.py
"""

import json
import os
import time

import requests

from dashboard_app.config import CONFIG
from dashboard_app.modbus_layer import ModbusReader
from dashboard_app import normalize

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
    row = {
        "id": 1,
        "serial_number": sys.get("serial_number", {}).get("value"),
        "inverter_model": sys.get("inverter_model", {}).get("value"),
        "protocol_version": sys.get("protocol_version", {}).get("value"),
        "product_model": sys.get("product_model", {}).get("value"),
    }
    # Upsert: insert or update row with id=1
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    requests.post(
        f"{url}/rest/v1/system_info?on_conflict=id",
        headers=headers, data=json.dumps([row]), timeout=10,
    )


def main():
    load_env()
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")

    if not url or not key:
        print("=" * 56)
        print(" ERROR: Missing Supabase credentials.")
        print(" Create a .env file in this folder with:")
        print("   SUPABASE_URL=https://<project>.supabase.co")
        print("   SUPABASE_SERVICE_KEY=<your service_role key>")
        print("=" * 56)
        raise SystemExit(1)

    print("=" * 56)
    print(" SOLIS MONITOR — CLOUD SYNCER")
    print("=" * 56)
    print(f" Inverter:  {CONFIG['host']}:{CONFIG['port']}")
    print(f" Supabase:  {url}")
    print(f" Sync every {SYNC_INTERVAL}s")
    print(" Press Ctrl+C to stop.")
    print()

    reader = ModbusReader()
    reader.start()

    sync_started = False
    while True:
        try:
            raw, errors = reader.get_raw_snapshot()
            identification = reader.get_identification()
            snapshot = normalize.build_snapshot(raw, errors, identification)

            if not sync_started:
                sync_system_info(snapshot, url, key)
                sync_started = True
                print(" System identity synced.")

            row = build_row(snapshot)
            row["ts_unix"] = time.time()
            row["ts_iso"] = time.strftime(
                "%Y-%m-%d %H:%M:%S", time.localtime(row["ts_unix"])
            )

            supabase_post("readings", [row], url, key)
            print(f"  [{row['ts_iso']}] pv={row['pv_power']} "
                  f"soc={row['battery_soc']} grid={row['grid_voltage']} "
                  f"load={row['house_load'] or row['backup_load']}")

        except requests.RequestException as exc:
            print(f"  ! upload failed: {exc}")
        except KeyboardInterrupt:
            break
        except Exception as exc:
            print(f"  ! error: {type(exc).__name__}: {exc}")

        time.sleep(SYNC_INTERVAL)


if __name__ == "__main__":
    main()

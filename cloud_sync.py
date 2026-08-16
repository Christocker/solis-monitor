"""
CLOUD SYNCER — STANDALONE MODE.

Reads the live inverter snapshot (via its OWN Modbus reader) and pushes
it to a Supabase cloud database every ~2 seconds.

NOTE: The S2-WL-ST logger allows only ONE Modbus TCP connection at a
time. Run EITHER this standalone script OR the web dashboard, not both.
The dashboard already runs an integrated cloud sync, so prefer:
    python run_dashboard.py
Use this standalone script only when the dashboard is not running.

Data flow:
    Inverter -> S2-WL-ST -> [this laptop: Modbus reader] -> Supabase
    -> Vercel website -> anyone online

Requirements:
    pip install -r requirements.txt

Configuration (environment variables, read from .env):
    SUPABASE_URL            e.g. https://abcdefgh.supabase.co
    SUPABASE_SERVICE_KEY    the "service_role" key (server-side only,
                            never expose to the website)

Run:
    python cloud_sync.py
"""

import time

from dashboard_app.config import CONFIG
from dashboard_app.modbus_layer import ModbusReader
from dashboard_app import cloud_sync as cs
from dashboard_app import normalize


def main():
    cs.load_env()
    url, key = cs.get_credentials()

    if not url or not key:
        print("=" * 56)
        print(" ERROR: Missing Supabase credentials.")
        print(" Create a .env file in this folder with:")
        print("   SUPABASE_URL=https://<project>.supabase.co")
        print("   SUPABASE_SERVICE_KEY=<your service_role key>")
        print("=" * 56)
        raise SystemExit(1)

    print("=" * 56)
    print(" SOLIS MONITOR — CLOUD SYNCER (STANDALONE)")
    print("=" * 56)
    print(f" Inverter:  {CONFIG['host']}:{CONFIG['port']}")
    print(f" Supabase:  {url}")
    print(f" Sync every {cs.SYNC_INTERVAL}s")
    print(" Press Ctrl+C to stop.")
    print()

    reader = ModbusReader()
    reader.start()

    sync_started = False
    next_tick = time.monotonic()
    while True:
        next_tick += cs.SYNC_INTERVAL
        try:
            raw, errors = reader.get_raw_snapshot()
            identification = reader.get_identification()
            snapshot = normalize.build_snapshot(raw, errors, identification)

            if not sync_started:
                cs.sync_system_info(snapshot, url, key)
                sync_started = True
                print(" System identity synced.")

            row = cs.build_row(snapshot)
            row["ts_unix"] = time.time()
            row["ts_iso"] = time.strftime(
                "%Y-%m-%d %H:%M:%S", time.localtime(row["ts_unix"])
            )

            cs.supabase_post("readings", [row], url, key)
            print(f"  [{row['ts_iso']}] pv={row['pv_power']} "
                  f"soc={row['battery_soc']} grid={row['grid_voltage']} "
                  f"load={row['house_load'] or row['backup_load']}")

        except KeyboardInterrupt:
            break
        except Exception as exc:
            print(f"  ! error: {type(exc).__name__}: {exc}")

        delay = next_tick - time.monotonic()
        if delay > 0:
            time.sleep(delay)


if __name__ == "__main__":
    main()

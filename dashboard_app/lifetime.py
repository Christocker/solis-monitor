"""
Shared lifetime-energy cache.

The laptop's SQLite archive is the authoritative source for lifetime totals.
The local API and the Supabase publisher both use this cache, so the full
history scan runs at most once per TTL instead of once per consumer.

Only the laptop has the complete raw history; the hosted site reads the
published `lifetime_stats` row and falls back to cloud-bucket estimates if
that row is unavailable.
"""

import threading
import time

from . import data_logger

TTL_S = 300.0

_cache_lock = threading.Lock()
_compute_lock = threading.Lock()
_cache = {"t": 0.0, "data": None}


def compute():
    """Scan the local archive once and return raw lifetime totals.

    Returns None when there is not enough data to integrate.
    """
    first, _last = data_logger.logger.min_max_time()
    if first is None:
        return None
    summary = data_logger.logger.energy_summary(first, time.time())
    if not summary.get("intervals"):
        return None
    return {
        "solar_kwh": round(summary["solar"], 3),
        "consumption_kwh": round(summary["consumption"], 3),
        "battery_charge_kwh": round(summary["battery_charge"], 3),
        "battery_discharge_kwh": round(summary["battery_discharge"], 3),
        "grid_import_kwh": round(summary["grid_import"], 3),
        "grid_export_kwh": round(summary["grid_export"], 3),
        "first_record": first,
        "samples": summary["samples"],
        "computed_at": time.time(),
    }


def get():
    """Return cached lifetime totals, recomputing when stale.

    Never raises: on a scan failure it returns the last known values (or None
    when the cache has never been filled).
    """
    now = time.time()
    with _cache_lock:
        cached = _cache["data"]
        if cached is not None and now - _cache["t"] < TTL_S:
            return dict(cached)

    with _compute_lock:
        # Another thread may have refreshed while this one waited.
        with _cache_lock:
            cached = _cache["data"]
            if cached is not None and time.time() - _cache["t"] < TTL_S:
                return dict(cached)

        try:
            data = compute()
        except Exception as exc:                       # noqa: BLE001
            print(f"[lifetime] compute failed: {type(exc).__name__}: {exc}")
            data = None

        if data is not None:
            with _cache_lock:
                _cache["data"] = data
                _cache["t"] = time.time()

        with _cache_lock:
            return dict(_cache["data"]) if _cache["data"] is not None else None


def peek():
    """Return the last cached totals without triggering a scan."""
    with _cache_lock:
        return dict(_cache["data"]) if _cache["data"] is not None else None

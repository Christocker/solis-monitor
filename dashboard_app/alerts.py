"""
ALERTS.

Evaluates the live snapshot on a short timer and raises edge-triggered alerts
with hysteresis, a hold time and a cooldown, so a noisy signal cannot spam.

Rules:
    battery_low       SOC <= 20 %, clears at >= 25 %
    battery_critical  SOC <= 10 %, clears at >= 15 %
    grid_lost         grid disconnected for >= 30 s, clears when connected
    inverter_offline  no fresh data for >= 60 s, clears when fresh

Notifications are optional: set NTFY_TOPIC (and optionally NTFY_URL/TOKEN) to
push via ntfy.sh. Alerts are always logged and exposed through the API.
"""

import json
import os
import sqlite3
import threading
import time

import requests

from . import modbus_layer
from . import normalize
from .config import GRID_CONNECTED_THRESHOLD_V

DB_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "alerts.db"
)
CHECK_INTERVAL = 5.0

# The grid is disconnected by design on this install, so "grid lost" is
# opt-in (ALERTS_GRID=1); the others protect the battery and the data feed.
ENABLED = {
    "battery_low": True,
    "battery_critical": True,
    "grid_lost": os.environ.get("ALERTS_GRID", "0") == "1",
    "inverter_offline": True,
}

RULES = [
    # key, severity, hold_s, cooldown_s, message
    ("battery_critical", "critical", 10.0, 3600.0, "Battery critically low"),
    ("battery_low", "warning", 10.0, 21600.0, "Battery low"),
    ("grid_lost", "warning", 30.0, 1800.0, "Grid lost"),
    ("inverter_offline", "critical", 60.0, 1800.0, "Inverter offline"),
]


class AlertManager:
    def __init__(self):
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._state = {}          # key -> dict(active, since, last_notified)
        self._init_db()
        self._load()

    # ------------------------------------------------------------------
    def _connect(self):
        conn = sqlite3.connect(DB_PATH, timeout=5.0)
        conn.execute(
            "CREATE TABLE IF NOT EXISTS alert_state ("
            "key TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 0, "
            "since REAL, last_notified REAL)"
        )
        return conn

    def _init_db(self):
        self._connect().close()

    def _load(self):
        conn = self._connect()
        try:
            for key, active, since, notified in conn.execute(
                    "SELECT key, active, since, last_notified FROM alert_state"):
                self._state[key] = {
                    "active": bool(active),
                    "since": since,
                    "last_notified": notified,
                }
        finally:
            conn.close()

    def _save(self, key):
        st = self._state.get(key, {})
        conn = self._connect()
        try:
            conn.execute(
                "INSERT INTO alert_state (key, active, since, last_notified) "
                "VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET "
                "active=excluded.active, since=excluded.since, "
                "last_notified=excluded.last_notified",
                (key, 1 if st.get("active") else 0,
                 st.get("since"), st.get("last_notified")),
            )
            conn.commit()
        finally:
            conn.close()

    # ------------------------------------------------------------------
    def _conditions(self):
        """Return (conditions dict, detail dict) from the live snapshot."""
        raw, errors = modbus_layer.reader.get_raw_snapshot()
        ident = modbus_layer.reader.get_identification()
        snap = normalize.build_snapshot(raw, errors, ident)
        stats = modbus_layer.reader.get_stats()

        soc_field = snap.get("battery", {}).get("soc", {})
        soc = (soc_field.get("value")
               if soc_field.get("state") == "available" else None)
        grid = snap.get("grid", {}).get("connected")

        last = stats.get("last_success_time")
        age = (time.time() - last) if last else None
        stale = age is None or age > 30.0

        return {
            "battery_critical": soc is not None and soc <= 10,
            "battery_low": soc is not None and soc <= 20,
            "grid_lost": grid is False,
            "inverter_offline": stale,
        }, {"soc": soc, "grid": grid, "age": age}

    def _hold(self, key):
        for k, _sev, hold, _cd, _msg in RULES:
            if k == key:
                return hold
        return 10.0

    def _cooldown(self, key):
        for k, _sev, _hold, cd, _msg in RULES:
            if k == key:
                return cd
        return 3600.0

    def _severity(self, key):
        for k, sev, _h, _c, _m in RULES:
            if k == key:
                return sev
        return "info"

    def _message(self, key, detail):
        soc = detail.get("soc")
        if key == "battery_critical":
            return f"Battery critically low: {soc:.0f}%" if soc is not None else "Battery critically low"
        if key == "battery_low":
            return f"Battery low: {soc:.0f}%" if soc is not None else "Battery low"
        if key == "grid_lost":
            return "Grid lost (running off-grid)"
        return "Inverter offline — no fresh data"

    def _clear_condition(self, key, detail):
        soc = detail.get("soc")
        if key == "battery_critical":
            return soc is not None and soc >= 15
        if key == "battery_low":
            return soc is not None and soc >= 25
        if key == "grid_lost":
            return detail.get("grid") is True
        if key == "inverter_offline":
            return not (detail.get("age") is None or detail.get("age") > 30.0)
        return True

    def evaluate(self, conditions, detail, now=None):
        """Pure-ish transition engine (also used by tests)."""
        now = now if now is not None else time.time()
        for key, _sev, _hold, _cd, _msg in RULES:
            if not ENABLED.get(key, True):
                continue
            st = self._state.setdefault(
                key, {"active": False, "since": None, "last_notified": None})
            triggered = conditions.get(key, False)
            cleared = self._clear_condition(key, detail)

            if not st["active"] and triggered:
                if st["since"] is None:
                    st["since"] = now
                    self._save(key)
                    continue
                if now - st["since"] >= self._hold(key):
                    st["active"] = True
                    self._save(key)
                    self._maybe_notify(key, detail, now)
            elif st["active"] and cleared:
                st["active"] = False
                st["since"] = None
                self._save(key)
            elif not st["active"] and not triggered:
                if st["since"] is not None:
                    st["since"] = None
                    self._save(key)

    def _maybe_notify(self, key, detail, now):
        st = self._state[key]
        last = st.get("last_notified")
        if last is not None and now - last < self._cooldown(key):
            return
        msg = self._message(key, detail)
        st["last_notified"] = now
        self._save(key)
        severity = self._severity(key)
        print(f"[alert:{severity}] {msg}")
        self._push(msg, severity)

    def _push(self, message, severity):
        topic = os.environ.get("NTFY_TOPIC", "").strip()
        if not topic:
            return
        base = os.environ.get("NTFY_URL", "https://ntfy.sh").rstrip("/")
        headers = {
            "Title": "Solis Monitor",
            "Priority": "high" if severity == "critical" else "default",
            "Tags": "warning" if severity == "critical" else "battery",
        }
        token = os.environ.get("NTFY_TOKEN", "").strip()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        try:
            requests.post(f"{base}/{topic}", data=message.encode("utf-8"),
                          headers=headers, timeout=5)
        except requests.RequestException:
            pass

    def active_alerts(self):
        now = time.time()
        with self._lock:
            out = []
            for key, st in self._state.items():
                if st.get("active"):
                    out.append({
                        "key": key,
                        "severity": self._severity(key),
                        "since": st.get("since"),
                        "message": self._message(key, {}),
                    })
        return out

    # ------------------------------------------------------------------
    def _loop(self):
        while not self._stop.is_set():
            try:
                cond, detail = self._conditions()
                self.evaluate(cond, detail)
            except Exception as exc:
                print(f"[alerts] error: {type(exc).__name__}: {exc}")
            self._stop.wait(CHECK_INTERVAL)

    def start(self):
        if self._thread is not None and self._thread.is_alive():
            return
        self._thread = threading.Thread(
            target=self._loop, daemon=True, name="alerts")
        self._thread.start()

    def stop(self):
        self._stop.set()


manager = AlertManager()


def start_alerts():
    manager.start()


def active_alerts():
    return manager.active_alerts()

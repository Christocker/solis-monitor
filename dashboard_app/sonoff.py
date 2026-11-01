"""
Grid-control relay (SONOFF MINIR4 through Home Assistant).

The relay switches the grid charger, so the rule is deliberately small and
hysteretic (the two thresholds must never be equal):

    SOC <= SONOFF_ON_SOC   -> relay ON   (start topping up from the grid)
    SOC >= SONOFF_OFF_SOC  -> relay OFF  (stop once the pack has recovered)

Between the thresholds nothing happens, which is what stops the relay
chattering when SOC sits near the boundary.

Safety rules:
  * SOC comes from the dashboard snapshot, so the controller can never
    disagree with what is on screen.
  * Stale inverter data (poller offline) means "do nothing", never "switch".
  * A 60 s minimum gap between relay actions protects the contacts.
  * A manual button press wins for SONOFF_MANUAL_HOLD_S.

This module only talks to Home Assistant; it never touches Modbus.
"""

import json
import os
import threading
import time

import requests

from .config import (
    SONOFF_ENABLED,
    SONOFF_ENTITY,
    SONOFF_HA_TOKEN,
    SONOFF_HA_URL,
    SONOFF_EVAL_INTERVAL,
    SONOFF_MANUAL_HOLD_S,
    SONOFF_MIN_ACTION_GAP,
    SONOFF_OFF_SOC,
    SONOFF_ON_SOC,
    SONOFF_STALE_S,
)

# Tiny state file so "auto" and the last action survive a restart.
_STATE_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "sonoff_state.json",
)

_HTTP_TIMEOUT = 5.0
_STATE_TTL = 5.0            # seconds a fetched relay state stays valid


class SonoffController:
    """Hysteretic SOC controller for the grid-control relay."""

    def __init__(self, soc_provider=None):
        # soc_provider() -> (soc_percent | None, data_timestamp | None)
        self._soc_provider = soc_provider

        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread = None

        # Relay state cache
        self._state = None          # "on" | "off" | None
        self._state_ts = 0.0
        self._name = None           # friendly name from Home Assistant
        self._reachable = None      # True | False | None (not polled yet)
        self._error = None

        # Automation state
        self._auto = True
        self._manual_until = 0.0
        self._last_action = None
        self._last_action_ts = 0.0
        self._last_soc = None
        self._last_soc_ts = None

        self._load_state()

    # ------------------------------------------------------------------
    # Configuration / state
    # ------------------------------------------------------------------
    @property
    def configured(self):
        return bool(SONOFF_ENABLED and SONOFF_HA_TOKEN and SONOFF_ENTITY)

    def set_soc_provider(self, provider):
        self._soc_provider = provider

    def current_state(self, force=False):
        """Public accessor for the relay state ("on"/"off"/None)."""
        return self._get_state(force=force)

    def _headers(self):
        return {
            "Authorization": f"Bearer {SONOFF_HA_TOKEN}",
            "Content-Type": "application/json",
        }

    def _load_state(self):
        try:
            with open(_STATE_FILE, encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            return
        self._auto = bool(data.get("auto", True))
        action = data.get("last_action")
        if isinstance(action, dict):
            self._last_action = action
            self._last_action_ts = float(action.get("at") or 0.0)

    def _save_state(self):
        payload = {"auto": self._auto, "last_action": self._last_action}
        try:
            tmp = _STATE_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(payload, fh)
            os.replace(tmp, _STATE_FILE)
        except OSError:
            pass

    # ------------------------------------------------------------------
    # Home Assistant calls
    # ------------------------------------------------------------------
    def _get_state(self, force=False):
        """Return the relay state ("on"/"off") or None when unreachable."""
        now = time.time()
        with self._lock:
            if (not force and self._state is not None
                    and now - self._state_ts < _STATE_TTL):
                return self._state
        try:
            resp = requests.get(
                f"{SONOFF_HA_URL}/api/states/{SONOFF_ENTITY}",
                headers=self._headers(), timeout=_HTTP_TIMEOUT,
            )
            resp.raise_for_status()
            body = resp.json() or {}
            state = body.get("state")
            state = state if state in ("on", "off") else None
            friendly = (body.get("attributes") or {}).get("friendly_name")
            with self._lock:
                self._state = state
                self._state_ts = now
                if friendly:
                    self._name = friendly
                self._reachable = True
                self._error = None
            return state
        except Exception as exc:                       # noqa: BLE001 - report, never raise
            with self._lock:
                self._reachable = False
                self._error = f"{type(exc).__name__}: {exc}"[:200]
            return None

    def _call(self, service):
        """Call switch.turn_on / switch.turn_off. True on success."""
        try:
            resp = requests.post(
                f"{SONOFF_HA_URL}/api/services/switch/{service}",
                headers=self._headers(),
                json={"entity_id": SONOFF_ENTITY},
                timeout=_HTTP_TIMEOUT,
            )
            resp.raise_for_status()
            with self._lock:
                self._state = "on" if service == "turn_on" else "off"
                self._state_ts = time.time()
                self._reachable = True
                self._error = None
            return True
        except Exception as exc:                       # noqa: BLE001
            with self._lock:
                self._reachable = False
                self._error = f"{type(exc).__name__}: {exc}"[:200]
            return False

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------
    def _act(self, action, reason, ignore_gap=False):
        now = time.time()
        if not ignore_gap and now - self._last_action_ts < SONOFF_MIN_ACTION_GAP:
            return False
        ok = self._call("turn_on" if action == "on" else "turn_off")
        if ok:
            with self._lock:
                self._last_action_ts = now
                self._last_action = {
                    "action": action,
                    "soc": self._last_soc,
                    "at": now,
                    "reason": reason,
                }
            self._save_state()
            print(f"[sonoff] relay -> {action.upper()} ({reason})")
        return ok

    def manual(self, on):
        """Manual button press: set the relay and hold automation off briefly."""
        if not self.configured:
            return self.status()
        state = self._get_state(force=True)
        if state is None:
            return self.status()
        want = "on" if on else "off"
        if state != want:
            if self._act(want, "manual override", ignore_gap=True):
                with self._lock:
                    self._manual_until = time.time() + SONOFF_MANUAL_HOLD_S
        return self.status()

    def set_auto(self, enabled):
        with self._lock:
            self._auto = bool(enabled)
            if self._auto:
                self._manual_until = 0.0
        self._save_state()
        return self.status()

    # ------------------------------------------------------------------
    # Control loop
    # ------------------------------------------------------------------
    def _evaluate(self):
        if not self.configured or not self._auto or self._soc_provider is None:
            return

        try:
            soc, data_ts = self._soc_provider()
        except Exception as exc:                       # noqa: BLE001
            self._error = f"SOC provider: {type(exc).__name__}: {exc}"[:200]
            return

        now = time.time()
        with self._lock:
            self._last_soc = soc
            self._last_soc_ts = data_ts

        if soc is None:
            return                                     # unknown SOC: never guess
        if data_ts is not None and now - data_ts > SONOFF_STALE_S:
            return                                     # stale data: hold position
        if now < self._manual_until:
            return                                     # user pressed the button

        state = self._get_state()
        if state is None:
            return

        if state == "off" and soc <= SONOFF_ON_SOC:
            self._act("on", f"SOC {soc:g}% <= {SONOFF_ON_SOC:g}%")
        elif state == "on" and soc >= SONOFF_OFF_SOC:
            self._act("off", f"SOC {soc:g}% >= {SONOFF_OFF_SOC:g}%")

    def _loop(self):
        # Evaluate once immediately, then on a fixed cadence. Exceptions are
        # contained so a Home Assistant hiccup can never kill the thread.
        while not self._stop.is_set():
            try:
                self._evaluate()
            except Exception as exc:                   # noqa: BLE001
                with self._lock:
                    self._error = f"loop: {type(exc).__name__}: {exc}"[:200]
            self._stop.wait(SONOFF_EVAL_INTERVAL)

    def start(self):
        if not self.configured:
            return
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop, daemon=True, name="sonoff-control",
        )
        self._thread.start()

    def stop(self):
        self._stop.set()

    # ------------------------------------------------------------------
    # Status for the API / UI
    # ------------------------------------------------------------------
    def status(self):
        with self._lock:
            now = time.time()
            return {
                "configured": self.configured,
                "entity": SONOFF_ENTITY,
                "name": self._name,
                "state": self._state,
                "reachable": self._reachable,
                "auto": self._auto,
                "manual_until": self._manual_until or None,
                "manual_hold_s": SONOFF_MANUAL_HOLD_S,
                "on_soc": SONOFF_ON_SOC,
                "off_soc": SONOFF_OFF_SOC,
                "soc": self._last_soc,
                "soc_age": (round(now - self._last_soc_ts, 1)
                            if self._last_soc_ts else None),
                "last_action": self._last_action,
                "error": self._error,
            }

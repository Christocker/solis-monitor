"""
Relay control from the public website (Supabase command queue).

The hosted site is static, so it cannot reach Home Assistant. Instead it
writes the desired relay state to `relay_control`, this module polls that row
with the service_role key, applies the change through SonoffController, and
publishes the resulting state to `relay_status` for the site to display.

Safety:
  * Commands older than STALE_COMMAND_S are ignored (never replay a stale
    click after the laptop was offline).
  * Applying a command goes through SonoffController.manual(), so it also
    takes the automatic SOC control out of the way for the usual hold time.
  * A failed command is retried, but is idempotent (manual() does nothing if
    the relay is already in that state).
"""

import json
import threading
import time
from datetime import datetime, timezone

import requests

from .cloud_sync import get_credentials

POLL_INTERVAL_S = 2.0
STATUS_EVERY_S = 10.0
STALE_COMMAND_S = 300.0        # ignore a queued command older than this
HTTP_TIMEOUT_S = 8.0


def _parse_ts(value):
    """ISO-8601 (Supabase timestamptz) -> unix seconds, or None."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (ValueError, AttributeError):
        return None


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


class RelayCloud:
    """Applies website relay commands and publishes the relay state."""

    def __init__(self, controller):
        self._controller = controller
        self._url, self._key = get_credentials()
        self._stop = threading.Event()
        self._thread = None
        self._last_status = 0.0
        self._last_error = None

    @property
    def configured(self):
        return bool(self._url and self._key and self._controller.configured)

    # ------------------------------------------------------------------
    # HTTP helpers
    # ------------------------------------------------------------------
    def _headers(self, prefer_minimal=True):
        headers = {
            "apikey": self._key,
            "Authorization": f"Bearer {self._key}",
            "Content-Type": "application/json",
        }
        if prefer_minimal:
            headers["Prefer"] = "return=minimal"
        return headers

    def _get_command(self):
        resp = requests.get(
            f"{self._url}/rest/v1/relay_control?id=eq.1&select=*",
            headers=self._headers(prefer_minimal=False), timeout=HTTP_TIMEOUT_S,
        )
        resp.raise_for_status()
        rows = resp.json() or []
        return rows[0] if rows else None

    def _patch(self, table, payload):
        resp = requests.patch(
            f"{self._url}/rest/v1/{table}?id=eq.1",
            headers=self._headers(), data=json.dumps(payload),
            timeout=HTTP_TIMEOUT_S,
        )
        resp.raise_for_status()

    # ------------------------------------------------------------------
    # Work
    # ------------------------------------------------------------------
    def _publish_status(self):
        status = self._controller.status()
        self._patch("relay_status", {
            "state": status.get("state"),
            "reachable": status.get("reachable"),
            "auto": status.get("auto"),
            "soc": status.get("soc"),
            "on_soc": status.get("on_soc"),
            "off_soc": status.get("off_soc"),
            "last_action": status.get("last_action"),
            "updated_at": _now_iso(),
        })
        self._last_status = time.time()

    def _apply_command(self, row):
        requested_at = row.get("requested_at")
        applied_at = row.get("applied_at")
        if not requested_at or requested_at == applied_at:
            return False

        desired = row.get("desired_state")
        stamp = _parse_ts(requested_at)
        age = (time.time() - stamp) if stamp is not None else None

        if desired not in ("on", "off"):
            self._mark_applied(requested_at)
            return False
        if age is None or age > STALE_COMMAND_S or age < -60:
            # Too old to trust (or a clock-skewed future stamp): drop it.
            print(f"[relay-cloud] ignoring stale command ({age}s)")
            self._mark_applied(requested_at)
            return False

        print(f"[relay-cloud] applying web command: {desired.upper()}")
        self._controller.manual(desired == "on")
        self._mark_applied(requested_at)
        self._publish_status()
        return True

    def _mark_applied(self, requested_at):
        try:
            self._patch("relay_control", {"applied_at": requested_at})
        except requests.RequestException as exc:
            self._note_error(f"mark applied: {exc}")

    def _note_error(self, message):
        if message != self._last_error:
            print(f"[relay-cloud] {message}")
            self._last_error = message

    def _sync_once(self):
        row = self._get_command()
        if row:
            self._apply_command(row)

        if time.time() - self._last_status >= STATUS_EVERY_S:
            self._publish_status()

    def _loop(self):
        # First publish gives the site something to show immediately.
        try:
            self._publish_status()
        except Exception as exc:                       # noqa: BLE001
            self._note_error(f"initial status: {exc}")

        while not self._stop.is_set():
            try:
                self._sync_once()
                self._last_error = None
            except Exception as exc:                   # noqa: BLE001
                self._note_error(f"{type(exc).__name__}: {exc}")
            self._stop.wait(POLL_INTERVAL_S)

    def start(self):
        if not self.configured:
            return
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop, daemon=True, name="relay-cloud",
        )
        self._thread.start()

    def stop(self):
        self._stop.set()

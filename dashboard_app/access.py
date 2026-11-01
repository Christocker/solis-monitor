"""
LAN access gate: MAC allowlist with a password fallback.

The dashboard is served on the local network, so most clients already appear
in the kernel's ARP table and can be identified by MAC. Devices that are not
on the allowlist (VPN, another subnet, a phone using a randomised Wi-Fi
address, a browser with no ARP entry) get the password form instead.

Deliberately conservative:
  * Only ``request.remote_addr`` is trusted - X-Forwarded-For is ignored,
    because anyone can send it.
  * Unresolvable MAC => "not allowed", never "allowed".
  * Loopback and this machine's own addresses are always allowed, so the
    local service and its own health checks never lock themselves out.
  * A MAC allowlist is a convenience filter, not real security (MACs can be
    spoofed). The password is what actually keeps people out.
"""

import hmac
import os
import re
import subprocess
import threading
import time
from datetime import timedelta

from flask import (
    jsonify, redirect, render_template, request, session, url_for,
)

from .config import (
    DASHBOARD_ALLOWED_MACS,
    DASHBOARD_LOGIN_MAX_TRIES,
    DASHBOARD_LOGIN_WINDOW_S,
    DASHBOARD_PASSWORD,
    DASHBOARD_SESSION_DAYS,
)

_MAC_RE = re.compile(r"^[0-9a-f]{2}(:[0-9a-f]{2}){5}$")

_ALLOWED_MACS = set()
for _part in (DASHBOARD_ALLOWED_MACS or "").replace(";", ",").split(","):
    _mac = _part.strip().lower().replace("-", ":")
    if _MAC_RE.match(_mac):
        _ALLOWED_MACS.add(_mac)

_arp_lock = threading.Lock()
_arp_cache = {"t": 0.0, "table": {}}
_local_lock = threading.Lock()
_local_cache = {"t": 0.0, "ips": set()}

_fail_lock = threading.Lock()
_failures = {}          # ip -> [timestamps]


# ----------------------------------------------------------------------
# Network helpers
# ----------------------------------------------------------------------
def _refresh_arp():
    table = {}
    try:
        out = subprocess.run(
            ["ip", "neigh", "show"], capture_output=True, text=True, timeout=2,
        ).stdout
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 5 and "lladdr" in parts:
                idx = parts.index("lladdr")
                if idx + 1 < len(parts):
                    table[parts[0]] = parts[idx + 1].lower()
    except (OSError, subprocess.SubprocessError):
        pass
    if not table:
        try:
            with open("/proc/net/arp", encoding="ascii", errors="ignore") as fh:
                next(fh, None)
                for line in fh:
                    parts = line.split()
                    if len(parts) >= 4 and parts[3] != "00:00:00:00:00:00":
                        table[parts[0]] = parts[3].lower()
        except OSError:
            pass
    return table


def mac_for_ip(ip):
    """Best-effort MAC lookup with a short cache (ARP entries change)."""
    if not ip:
        return None
    now = time.time()
    with _arp_lock:
        if now - _arp_cache["t"] > 5.0 or ip not in _arp_cache["table"]:
            _arp_cache["table"] = _refresh_arp()
            _arp_cache["t"] = now
        return _arp_cache["table"].get(ip)


def _refresh_local_ips():
    ips = {"127.0.0.1", "::1"}
    try:
        out = subprocess.run(
            ["ip", "-4", "-o", "addr", "show"],
            capture_output=True, text=True, timeout=2,
        ).stdout
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 4 and parts[2] == "inet":
                ips.add(parts[3].split("/")[0])
    except (OSError, subprocess.SubprocessError):
        pass
    return ips


def _is_local(ip):
    now = time.time()
    with _local_lock:
        if now - _local_cache["t"] > 60.0 or not _local_cache["ips"]:
            _local_cache["ips"] = _refresh_local_ips()
            _local_cache["t"] = now
        return ip in _local_cache["ips"]


# ----------------------------------------------------------------------
# Brute-force limiting
# ----------------------------------------------------------------------
def _rate_ok(ip):
    now = time.time()
    with _fail_lock:
        stamps = [t for t in _failures.get(ip, []) if now - t < DASHBOARD_LOGIN_WINDOW_S]
        _failures[ip] = stamps
        if not stamps:
            return True
        return len(stamps) < DASHBOARD_LOGIN_MAX_TRIES


def _note_failure(ip):
    with _fail_lock:
        _failures.setdefault(ip, []).append(time.time())


# ----------------------------------------------------------------------
# Session secret
# ----------------------------------------------------------------------
def _secret_key(app):
    env_key = os.environ.get("SECRET_KEY", "").strip()
    if env_key:
        return env_key
    try:
        os.makedirs(app.instance_path, exist_ok=True)
        path = os.path.join(app.instance_path, "secret_key")
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                key = fh.read().strip()
            if key:
                return key
        key = os.urandom(32).hex()
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(key)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
        return key
    except OSError:
        # Last resort: a per-process key (sessions end on restart).
        return os.urandom(32).hex()


def _safe_next(target):
    if not target:
        return "/"
    if not target.startswith("/") or target.startswith("//"):
        return "/"
    return target


# ----------------------------------------------------------------------
# Flask wiring
# ----------------------------------------------------------------------
def init_app(app):
    app.secret_key = _secret_key(app)
    app.permanent_session_lifetime = timedelta(days=DASHBOARD_SESSION_DAYS)
    app.config["SESSION_COOKIE_HTTPONLY"] = True
    app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

    @app.before_request
    def _gate():
        path = request.path
        if path == "/login" or path == "/logout" or path.startswith("/static/"):
            return None

        ip = request.remote_addr or ""
        if _is_local(ip):
            return None

        mac = mac_for_ip(ip)
        if mac and mac in _ALLOWED_MACS:
            return None

        if session.get("access_granted"):
            return None

        if path.startswith("/api/"):
            return jsonify({
                "error": "auth_required",
                "detail": "Sign in, or add this device's MAC to the allowlist.",
            }), 401
        return redirect(url_for("login", next=path))

    @app.route("/login", methods=["GET", "POST"])
    def login():
        ip = request.remote_addr or ""
        mac = mac_for_ip(ip)
        nxt = _safe_next(request.values.get("next") or "/")
        error = None

        if request.method == "POST":
            if not DASHBOARD_PASSWORD:
                error = "No dashboard password is configured on the server."
            elif not _rate_ok(ip):
                error = "Too many attempts. Wait a few minutes and try again."
            elif hmac.compare_digest(request.form.get("password", ""),
                                     DASHBOARD_PASSWORD):
                session.permanent = True
                session["access_granted"] = True
                return redirect(nxt)
            else:
                _note_failure(ip)
                error = "Wrong password."

        return render_template(
            "login.html",
            error=error,
            ip=ip,
            mac=mac,
            next=nxt,
            has_password=bool(DASHBOARD_PASSWORD),
            allowlist_size=len(_ALLOWED_MACS),
        )

    @app.route("/logout")
    def logout():
        session.pop("access_granted", None)
        return redirect(url_for("login"))

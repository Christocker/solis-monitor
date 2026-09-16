"""
LAYER 1: MODBUS / DATA ACQUISITION LAYER.

Responsibility:
  - Own the pymodbus TCP client.
  - Read the verified registers on a background thread.
  - Keep a thread-safe in-memory store of the latest raw readings.

This layer knows NOTHING about the GUI or the API. It only:
  - connects to the logger,
  - reads registers from registers.py,
  - stores {key: raw_registers_or_None} plus read/connection statistics.

Layers above consume the result of get_raw_snapshot().
"""

import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from pymodbus.client import ModbusTcpClient
from pymodbus.exceptions import ModbusException, ConnectionException

from .config import (
    CONFIG, POLL_INTERVAL, DEMO_MODE,
    DISCOVERY_ENABLED, DISCOVERY_AFTER, DISCOVERY_INTERVAL,
)
from . import registers as regmap


class ModbusReader:
    """Background Modbus TCP reader producing raw register snapshots."""

    def __init__(self, config=None):
        self._config = config or CONFIG
        self._lock = threading.Lock()
        self._stop_event = threading.Event()

        self._client = None
        self.connected = False
        # Throttle reconnect attempts (exponential backoff) so an offline
        # logger cannot cause a connect storm across the register reads.
        self._next_connect_attempt = 0.0
        self._connect_backoff = 1.0
        # LAN auto-discovery state (handles the logger's DHCP lease moving).
        self._connect_fail_since = None
        self._last_discovery = 0.0

        # Latest raw snapshot: {key: list_of_register_values | None}
        self._raw = {}
        # Per-key error string when the last read failed
        self._errors = {}
        # Statistics
        self._stats = {
            "connection_errors": 0,
            "read_errors": 0,
            "total_reads": 0,
            "last_success_time": None,
            "last_error_time": None,
            "last_error_message": None,
        }

        self._thread = None

    # ------------------------------------------------------------------
    # Client management
    # ------------------------------------------------------------------
    def _discover_host(self):
        """Scan the local subnet for the Solis logger and adopt it.

        Used only after the configured host has been unreachable for a while,
        so a changed DHCP lease self-heals. Returns the discovered IP or None.
        """
        host = self._config["host"]
        try:
            socket.inet_aton(host)
        except OSError:
            return None                       # not an IPv4 address
        subnet = host.rsplit(".", 1)[0]
        port = self._config["port"]
        slave = self._config["slave_id"]

        def probe(ip):
            if ip == host:
                return None
            try:
                with socket.create_connection((ip, port), timeout=0.4):
                    pass
            except OSError:
                return None
            try:
                cli = ModbusTcpClient(ip, port=port, timeout=1.5)
                if cli.connect():
                    res = cli.read_input_registers(
                        address=33049, count=1, device_id=slave
                    )
                    cli.close()
                    if not res.isError():
                        return ip
            except Exception:
                pass
            return None

        ips = [f"{subnet}.{i}" for i in range(1, 255)]
        try:
            with ThreadPoolExecutor(max_workers=64) as pool:
                for found in pool.map(probe, ips):
                    if found:
                        return found
        except Exception:
            return None
        return None

    def _get_client(self):
        """Return a connected client, reconnecting if needed.

        Reconnection is throttled with exponential backoff so an offline logger
        cannot trigger one connect attempt per register read. If the host has
        been unreachable for a while, a LAN scan is attempted so a changed
        DHCP lease self-heals.
        """
        if self._client is not None and self.connected:
            return self._client
        now = time.time()
        if now < self._next_connect_attempt:
            return self._client

        # Self-heal: find the logger again if it moved on the network.
        if (DISCOVERY_ENABLED and self._connect_fail_since is not None
                and now - self._connect_fail_since >= DISCOVERY_AFTER
                and now - self._last_discovery >= DISCOVERY_INTERVAL):
            self._last_discovery = now
            found = self._discover_host()
            if found and found != self._config["host"]:
                self._config["host"] = found
                self._next_connect_attempt = 0.0
                self._connect_backoff = 1.0
                now = time.time()

        try:
            if self._client is not None:
                self._client.close()
        except Exception:
            pass
        self._client = ModbusTcpClient(
            self._config["host"],
            port=self._config["port"],
            timeout=self._config["timeout"],
        )
        try:
            self.connected = bool(self._client.connect())
        except Exception:
            self.connected = False
        with self._lock:
            if self.connected:
                self._connect_backoff = 1.0
                self._connect_fail_since = None
            else:
                if self._connect_fail_since is None:
                    self._connect_fail_since = now
                self._stats["connection_errors"] += 1
                self._stats["last_error_time"] = time.time()
                self._stats["last_error_message"] = "TCP connection failed"
                self._next_connect_attempt = now + self._connect_backoff
                self._connect_backoff = min(self._connect_backoff * 2, 30.0)
        return self._client

    def _disconnect(self):
        try:
            if self._client is not None:
                self._client.close()
        except Exception:
            pass
        self._client = None
        self.connected = False

    # ------------------------------------------------------------------
    # Single register read
    # ------------------------------------------------------------------
    def _read_register(self, reg_def):
        """Read one register definition; return list of raw values or None."""
        client = self._get_client()
        if not self.connected:
            return None

        try:
            if reg_def["function"] == 3:
                result = client.read_holding_registers(
                    address=reg_def["address"],
                    count=reg_def["count"],
                    device_id=self._config["slave_id"],
                )
            else:
                result = client.read_input_registers(
                    address=reg_def["address"],
                    count=reg_def["count"],
                    device_id=self._config["slave_id"],
                )

            if result.isError():
                raise ModbusException(
                    f"exception 0x{result.exception_code:02X}"
                )
            return list(result.registers)

        except (ConnectionException, ModbusException, OSError) as exc:
            self.connected = False
            with self._lock:
                self._stats["read_errors"] += 1
                self._stats["last_error_time"] = time.time()
                self._stats["last_error_message"] = str(exc)
            return None

    # ------------------------------------------------------------------
    # Full cycle read
    # ------------------------------------------------------------------
    def read_cycle(self):
        """Read all registers once. Returns (raw, errors)."""
        raw = {}
        errors = {}
        for reg_def in regmap.SENSOR_REGISTERS:
            values = self._read_register(reg_def)
            raw[reg_def["key"]] = values
            errors[reg_def["key"]] = None if values is not None else (
                self._stats["last_error_message"]
            )
            with self._lock:
                self._stats["total_reads"] += 1
            if self._config.get("retries") and values is None:
                # one retry per register on failure
                time.sleep(self._config.get("retry_delay", 0.5))
                values = self._read_register(reg_def)
                raw[reg_def["key"]] = values
                errors[reg_def["key"]] = None if values is not None else (
                    self._stats["last_error_message"]
                )
                with self._lock:
                    self._stats["total_reads"] += 1
        return raw, errors

    def read_identification(self):
        """Read identification registers once (serial, model, versions)."""
        raw = {}
        for reg_def in regmap.IDENTIFICATION_REGISTERS:
            values = self._read_register(reg_def)
            raw[reg_def["key"]] = values
        return raw

    # ------------------------------------------------------------------
    # Background thread
    # ------------------------------------------------------------------
    def _poll_loop(self):
        # Never let an unexpected exception kill the poller thread: that
        # would freeze the snapshot and leave the UI claiming "Connected".
        try:
            identification = self.read_identification()
            with self._lock:
                self._identification = identification
        except Exception as exc:
            with self._lock:
                self._stats["last_error_time"] = time.time()
                self._stats["last_error_message"] = f"identification: {exc}"

        while not self._stop_event.is_set():
            try:
                raw, errors = self.read_cycle()
                with self._lock:
                    self._raw = raw
                    self._errors = errors
                    if any(v is not None for v in raw.values()):
                        self._stats["last_success_time"] = time.time()
            except Exception as exc:
                with self._lock:
                    self._stats["last_error_time"] = time.time()
                    self._stats["last_error_message"] = f"poll: {exc}"
            self._stop_event.wait(POLL_INTERVAL)

    def start(self):
        """Start the background polling thread."""
        if self._thread is not None and self._thread.is_alive():
            return
        self._thread = threading.Thread(
            target=self._poll_loop, daemon=True, name="modbus-poller"
        )
        self._thread.start()

    def stop(self):
        self._stop_event.set()
        self._disconnect()

    # ------------------------------------------------------------------
    # Public accessors (thread-safe)
    # ------------------------------------------------------------------
    def get_raw_snapshot(self):
        with self._lock:
            return dict(self._raw), dict(self._errors)

    def get_identification(self):
        with self._lock:
            return dict(getattr(self, "_identification", {}))

    def get_stats(self):
        with self._lock:
            return dict(self._stats)


# ------------------------------------------------------------------
# DEMO mode fallback: clearly-labeled mock data for UI development.
# ------------------------------------------------------------------
def build_demo_snapshot():
    """Return clearly-labeled mock data. NEVER used unless DEMO_MODE=True."""
    import random

    def _u16(v):
        return max(0, min(0xFFFF, int(round(v))))

    def _reg16(base, jitter=0.0, signed=False):
        v = int(round(base + jitter * (random.random() - 0.5)))
        if signed and v < 0:
            v += 0x10000
        return [_u16(v)]

    def _reg32(base, jitter=0.0, signed=False):
        v = int(round(base + jitter * (random.random() - 0.5)))
        if signed and v < 0:
            v += 1 << 32
        v &= 0xFFFFFFFF
        return [(v >> 16) & 0xFFFF, v & 0xFFFF]

    raw = {
        "pv1_voltage": _reg16(3060, 50),
        "pv1_current": _reg16(28, 4),
        "pv2_voltage": _reg16(1300, 30),
        "pv2_current": _reg16(28, 4),
        "pv_power_total": _reg32(1200, 100),
        "grid_voltage": _reg16(2300, 10),
        "grid_frequency": _reg16(5000, 5),
        "ac_power": _reg32(1150, 80, signed=True),
        "battery_voltage": _reg16(541, 3),
        "battery_current": _reg16(0, 5, signed=True),
        "battery_soc": _reg16(98, 2),
        "battery_soh": _reg16(100, 1),
        "bms_voltage": _reg16(5439, 5),
        "house_load": _reg16(0, 1),
        "backup_load": _reg16(1160, 40),
        "battery_power": _reg32(0, 10, signed=True),
    }
    errors = {k: None for k in raw}
    return raw, errors


# Single shared reader instance for the whole application.
reader = ModbusReader()


def start_poller():
    """Start the shared background poller (idempotent)."""
    if DEMO_MODE:
        return  # demo mode: no Modbus thread
    reader.start()

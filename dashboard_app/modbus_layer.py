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

import threading
import time

from pymodbus.client import ModbusTcpClient
from pymodbus.exceptions import ModbusException, ConnectionException

from .config import CONFIG, POLL_INTERVAL, DEMO_MODE
from . import registers as regmap


class ModbusReader:
    """Background Modbus TCP reader producing raw register snapshots."""

    def __init__(self, config=None):
        self._config = config or CONFIG
        self._lock = threading.Lock()
        self._stop_event = threading.Event()

        self._client = None
        self.connected = False

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
    def _get_client(self):
        """Return a connected client, reconnecting if needed."""
        if self._client is not None and self.connected:
            return self._client
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
        self.connected = bool(self._client.connect())
        if not self.connected:
            with self._lock:
                self._stats["connection_errors"] += 1
                self._stats["last_error_time"] = time.time()
                self._stats["last_error_message"] = "TCP connection failed"
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
        identification = self.read_identification()
        with self._lock:
            self._identification = identification

        while not self._stop_event.is_set():
            raw, errors = self.read_cycle()
            with self._lock:
                self._raw = raw
                self._errors = errors
                if any(v is not None for v in raw.values()):
                    self._stats["last_success_time"] = time.time()
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

    def reg(key, base, jitter=0.0):
        import time as _t
        v = base + jitter * (random.random() - 0.5)
        return [int(v)]

    raw = {
        "pv1_voltage": reg("pv1_voltage", 3060, 50),
        "pv1_current": reg("pv1_current", 28, 4),
        "pv2_voltage": reg("pv2_voltage", 1300, 30),
        "pv2_current": reg("pv2_current", 28, 4),
        "pv_power_total": reg("pv_power_total", 1200, 100),
        "grid_voltage": reg("grid_voltage", 15, 5),
        "grid_frequency": reg("grid_frequency", 0, 1),
        "ac_power": reg("ac_power", 1150, 80),
        "battery_voltage": reg("battery_voltage", 541, 3),
        "battery_current": reg("battery_current", 0, 5),
        "battery_soc": reg("battery_soc", 98, 2),
        "battery_soh": reg("battery_soh", 100, 1),
        "bms_voltage": reg("bms_voltage", 5439, 5),
        "house_load": reg("house_load", 0, 1),
        "backup_load": reg("backup_load", 1160, 40),
        "battery_power": reg("battery_power", 0, 10),
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

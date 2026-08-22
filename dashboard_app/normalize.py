"""
LAYER 2: DATA NORMALIZATION LAYER.

Responsibility:
  - Convert raw register values (from Layer 1) into a normalized,
    state-aware data structure.
  - Every field carries a state so the GUI can render real values,
    '--' for unverified/unavailable, and error indicators — never
    fabricated numbers.

The GUI (Layer 4) and API (Layer 3) consume ONLY this normalized shape.
"""

import time

from .config import GRID_CONNECTED_THRESHOLD_V, DEMO_MODE
from . import registers as regmap


# Field states
AVAILABLE = "available"       # real value from a verified/documented register
UNVERIFIED = "unverified"     # no verified register exists yet -> show '--'
UNAVAILABLE = "unavailable"   # known register but no data yet -> show '--'
ERROR = "error"               # read failed -> show '--' + error indicator


def _decode(reg_def, raw_values):
    """Decode raw 16-bit register list into a scaled float/int."""
    if raw_values is None:
        return None
    n = len(raw_values)

    if reg_def["data_type"] == "u16" and n >= 1:
        value = raw_values[0]
    elif reg_def["data_type"] == "s16" and n >= 1:
        value = raw_values[0]
        if value >= 0x8000:
            value -= 0x10000
    elif reg_def["data_type"] == "u32" and n >= 2:
        value = (raw_values[0] << 16) | raw_values[1]
    elif reg_def["data_type"] == "s32" and n >= 2:
        value = (raw_values[0] << 16) | raw_values[1]
        if value >= 0x80000000:
            value -= 0x100000000
    elif reg_def["data_type"] == "ascii":
        # ASCII is stored high-byte-first per register
        raw_bytes = b""
        for v in raw_values:
            raw_bytes += bytes([(v >> 8) & 0xFF, v & 0xFF])
        try:
            text = raw_bytes.decode("ascii", errors="replace")
        except UnicodeDecodeError:
            text = ""
        value = text.replace("\x00", "").strip()
    else:
        value = None

    if value is None:
        return None

    if reg_def["data_type"] == "ascii":
        return value
    return round(value * reg_def.get("scale", 1.0), 3)


def _field(reg_def, raw_values):
    """Build the normalized {value, state, unit, name} for one register."""
    value = _decode(reg_def, raw_values)
    if raw_values is None:
        state = ERROR
    elif value is None:
        state = UNAVAILABLE
    else:
        state = AVAILABLE
    return {
        "name": reg_def["name"],
        "value": value,
        "state": state,
        "unit": reg_def.get("unit", ""),
        "scale": reg_def.get("scale", 1.0),
        "address": reg_def["address"],
        "function": reg_def["function"],
    }


def _unverified_field(name, unit=""):
    """A placeholder field with no verified register: always shows '--'."""
    return {
        "name": name,
        "value": None,
        "state": UNVERIFIED,
        "unit": unit,
        "address": None,
        "function": None,
    }


def _unavailable_field(name, unit=""):
    """A field that exists but currently has no usable reading: shows '--'."""
    return {
        "name": name,
        "value": None,
        "state": UNAVAILABLE,
        "unit": unit,
        "address": None,
        "function": None,
    }


def build_snapshot(raw, errors, identification):
    """
    Build the complete normalized snapshot.

    raw           : {key: raw_register_list | None}
    errors        : {key: error_message | None}
    identification: {key: raw_register_list} (serial, model, versions)
    """
    now = time.time()

    def field(key):
        return _field(regmap.REGISTERS_BY_KEY[key], raw.get(key))

    # ---------------- Solar ----------------
    solar = {
        "power": field("pv_power_total"),
        "pv1_voltage": field("pv1_voltage"),
        "pv1_current": field("pv1_current"),
        "pv2_voltage": field("pv2_voltage"),
        "pv2_current": field("pv2_current"),
    }

    # ---------------- Battery ----------------
    # The ESINV-33000ID register convention (positive = charging) does NOT
    # apply to this specific S6-EH1P6K-L-PLUS. On THIS inverter, the register
    # returns: positive = DISCHARGING, negative = CHARGING.
    # The JS dashboard interprets positive = discharging directly.
    battery = {
        "voltage": field("battery_voltage"),
        "current": field("battery_current"),
        "power": field("battery_power"),
        "soc": field("battery_soc"),
        "soh": field("battery_soh"),
    }

    # ---------------- Grid ----------------
    # NOTE: register 33079 "ac_power" is the inverter's TOTAL AC output
    # power, NOT grid import/export. It is NOT shown as grid power.
    # Grid power stays unavailable until we verify a dedicated grid
    # import/export register.
    grid = {
        "voltage": field("grid_voltage"),
        "frequency": field("grid_frequency"),
        "power": _unavailable_field("Grid Power", "W"),
    }
    grid_v = grid["voltage"]["value"]
    grid["connected"] = (
        grid_v is not None and grid_v >= GRID_CONNECTED_THRESHOLD_V
    )

    # ---------------- Load ----------------
    # The S6-EH1P reports load on different registers depending on mode:
    #   - On-grid:  house_load (33147) = consumption through the grid port
    #   - Off-grid: backup_load (33148) = consumption on the backup output
    # The dashboard's "Load Power" shows the value matching the current mode.
    house_f = field("house_load")
    backup_f = field("backup_load")
    load = {
        "power": backup_f if not grid["connected"] else house_f,
        "house_load": house_f,
        "backup_power": backup_f,
    }

    # ---------------- Energy (no verified registers yet) ----------------
    energy = {
        "today_solar": _unverified_field("Today's Solar Generation", "kWh"),
        "today_consumption": _unverified_field("Today's Consumption", "kWh"),
        "today_battery_charge": _unverified_field("Today's Battery Charged", "kWh"),
        "today_battery_discharge": _unverified_field("Today's Battery Discharged", "kWh"),
        "grid_import": _unverified_field("Grid Import", "kWh"),
        "grid_export": _unverified_field("Grid Export", "kWh"),
    }

    # ---------------- System ----------------
    serial_raw = identification.get("serial_number")
    inv_type_raw = identification.get("inverter_type")
    model_raw = identification.get("product_model")
    dsp_raw = identification.get("dsp_version")
    hmi_raw = identification.get("hmi_version")

    serial = _decode(
        regmap.REGISTERS_BY_KEY["serial_number"], serial_raw
    ) if serial_raw is not None else None
    model = (
        _decode(regmap.REGISTERS_BY_KEY["product_model"], model_raw)
        if model_raw is not None else None
    )

    inv_type = inv_type_raw[0] if inv_type_raw else None
    protocol_version = ((inv_type >> 8) & 0xFF) if inv_type is not None else None
    model_code = (inv_type & 0xFF) if inv_type is not None else None

    online_fields = list(solar.values()) + list(battery.values()) + [
        grid["voltage"], grid["frequency"], grid["power"]
    ]
    system = {
        "online": any(f.get("state") == AVAILABLE for f in online_fields
                      if isinstance(f, dict)),
        "last_update": _iso_time(now),
        "inverter_model": {
            "name": "Inverter Model",
            "value": f"S6-EH1P6K-L-PLUS (code {model_code})" if model_code is not None else None,
            "state": AVAILABLE if model_code is not None else UNAVAILABLE,
        },
        "serial_number": {
            "name": "Serial Number",
            "value": serial,
            "state": AVAILABLE if serial else UNAVAILABLE,
        },
        "protocol_version": {
            "name": "Protocol Version",
            "value": protocol_version,
            "state": AVAILABLE if protocol_version is not None else UNAVAILABLE,
        },
        "product_model": {
            "name": "Product Model",
            "value": model,
            "state": AVAILABLE if model is not None else UNAVAILABLE,
        },
    }

    return {
        "solar": solar,
        "battery": battery,
        "grid": grid,
        "load": load,
        "energy": energy,
        "system": system,
        "timestamp": _iso_time(now),
        "demo": DEMO_MODE,
    }


def build_diagnostics_snapshot(raw, errors, stats):
    """
    Build the register-level diagnostics table data.
    One row per verified register with raw hex/dec, state, and error.
    """
    rows = []
    for reg_def in regmap.SENSOR_REGISTERS:
        values = raw.get(reg_def["key"])
        err = errors.get(reg_def["key"])
        decoded = _decode(reg_def, values)

        hex_vals = " ".join(f"0x{v:04X}" for v in values) if values else None
        dec_vals = values if values else None

        if err:
            state = ERROR
        elif values is None:
            state = UNAVAILABLE
        elif decoded is None:
            state = UNAVAILABLE
        else:
            state = AVAILABLE

        rows.append({
            "parameter": reg_def["name"],
            "key": reg_def["key"],
            "register": reg_def["address"],
            "function": reg_def["function"],
            "raw_hex": hex_vals,
            "raw_dec": dec_vals,
            "decoded": decoded,
            "unit": reg_def.get("unit", ""),
            "scale": reg_def.get("scale", 1.0),
            "confidence": reg_def["state"],
            "state": state,
            "error": err,
        })
    return {"rows": rows, "stats": stats}


def _iso_time(ts):
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts))

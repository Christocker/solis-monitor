"""
Verified register map for the Solis S6-EH1P6K-L-PLUS (ESINV-33000ID protocol).

All registers use Function 04 (Read Input Registers), no address offset.
Cross-validated against the inverter LCD on 2026-08-11.

This file is the SINGLE SOURCE OF TRUTH for the register map.
Both the Modbus layer (Layer 1) and the normalization layer (Layer 2)
read from this module.
"""

# State / confidence levels
VERIFIED = "verified"        # Confirmed on-device against LCD
DOCUMENTED = "documented"    # In official protocol, not yet LCD-checked
UNVERIFIED = "unverified"    # No reliable source yet

REGISTER_STATES = (VERIFIED, DOCUMENTED, UNVERIFIED)

# ===========================================================================
# VERIFIED REGISTER DEFINITIONS
# ===========================================================================
# Each entry:
#   key        : logical name used across the app
#   name       : human-readable display name
#   address    : Modbus register address (decimal, as sent on the wire)
#   count      : number of 16-bit registers
#   function   : Modbus function code (always 4 for this device)
#   data_type  : u16 | s16 | u32 | s32 | ascii
#   scale      : multiplier applied to the raw value
#   unit       : display unit
#   state      : confidence level (see above)
#   source     : provenance note
#   display    : whether this is shown on the dashboard (False = diagnostic only)

IDENTIFICATION_REGISTERS = [
    {
        "key": "serial_number",
        "name": "Serial Number",
        "address": 33004,
        "count": 8,
        "function": 4,
        "data_type": "ascii",
        "scale": 1.0,
        "unit": "",
        "state": VERIFIED,
        "source": "ESINV-33000ID protocol; read on-device 2026-08-11",
        "display": True,
    },
    {
        "key": "inverter_type",
        "name": "Inverter Type",
        "address": 35000,
        "count": 1,
        "function": 4,
        "data_type": "u16",
        "scale": 1.0,
        "unit": "",
        "state": VERIFIED,
        "source": "Solis RS485 protocol section 5.2",
        "display": True,
    },
    {
        "key": "product_model",
        "name": "Product Model",
        "address": 33000,
        "count": 1,
        "function": 4,
        "data_type": "u16",
        "scale": 1.0,
        "unit": "",
        "state": DOCUMENTED,
        "source": "ESINV-33000ID protocol",
        "display": True,
    },
    {
        "key": "dsp_version",
        "name": "DSP Version",
        "address": 33001,
        "count": 1,
        "function": 4,
        "data_type": "u16",
        "scale": 1.0,
        "unit": "",
        "state": DOCUMENTED,
        "source": "ESINV-33000ID protocol",
        "display": True,
    },
    {
        "key": "hmi_version",
        "name": "HMI Version",
        "address": 33002,
        "count": 1,
        "function": 4,
        "data_type": "u16",
        "scale": 1.0,
        "unit": "",
        "state": DOCUMENTED,
        "source": "ESINV-33000ID protocol",
        "display": True,
    },
]

SENSOR_REGISTERS = [
    # --- Solar / PV ---
    {
        "key": "pv1_voltage",
        "name": "PV1 Voltage",
        "address": 33049,
        "count": 1,
        "function": 4,
        "data_type": "u16",
        "scale": 0.1,
        "unit": "V",
        "state": VERIFIED,
        "source": "LCD cross-check 2026-08-11",
        "display": True,
    },
    {
        "key": "pv1_current",
        "name": "PV1 Current",
        "address": 33050,
        "count": 1,
        "function": 4,
        "data_type": "u16",
        "scale": 0.1,
        "unit": "A",
        "state": VERIFIED,
        "source": "LCD cross-check 2026-08-11",
        "display": True,
    },
    {
        "key": "pv2_voltage",
        "name": "PV2 Voltage",
        "address": 33051,
        "count": 1,
        "function": 4,
        "data_type": "u16",
        "scale": 0.1,
        "unit": "V",
        "state": VERIFIED,
        "source": "LCD cross-check 2026-08-11",
        "display": True,
    },
    {
        "key": "pv2_current",
        "name": "PV2 Current",
        "address": 33052,
        "count": 1,
        "function": 4,
        "data_type": "u16",
        "scale": 0.1,
        "unit": "A",
        "state": VERIFIED,
        "source": "LCD cross-check 2026-08-11",
        "display": True,
    },
    {
        "key": "pv_power_total",
        "name": "PV Power Total",
        "address": 33057,
        "count": 2,
        "function": 4,
        "data_type": "u32",
        "scale": 1.0,
        "unit": "W",
        "state": DOCUMENTED,
        "source": "ESINV-33000ID protocol",
        "display": True,
    },
    # --- Grid / AC ---
    {
        "key": "grid_voltage",
        "name": "Grid Voltage",
        "address": 33073,
        "count": 1,
        "function": 4,
        "data_type": "u16",
        "scale": 0.1,
        "unit": "V",
        "state": VERIFIED,
        "source": "ESINV-33000ID protocol",
        "display": True,
    },
    {
        "key": "grid_frequency",
        "name": "Grid Frequency",
        "address": 33094,
        "count": 1,
        "function": 4,
        "data_type": "u16",
        "scale": 0.01,
        "unit": "Hz",
        "state": VERIFIED,
        "source": "ESINV-33000ID protocol",
        "display": True,
    },
    {
        "key": "ac_power",
        "name": "Inverter AC Output Power",
        "address": 33079,
        "count": 2,
        "function": 4,
        "data_type": "s32",
        "scale": 1.0,
        "unit": "W",
        "state": DOCUMENTED,
        "source": "ESINV-33000ID protocol; NOT grid import/export — total AC output",
        "display": False,
    },
    # --- Battery ---
    {
        "key": "battery_voltage",
        "name": "Battery Voltage",
        "address": 33133,
        "count": 1,
        "function": 4,
        "data_type": "u16",
        "scale": 0.1,
        "unit": "V",
        "state": VERIFIED,
        "source": "LCD cross-check 2026-08-11",
        "display": True,
    },
    {
        "key": "battery_current",
        "name": "Battery Current",
        "address": 33134,
        "count": 1,
        "function": 4,
        "data_type": "s16",
        "scale": 0.1,
        "unit": "A",
        "state": VERIFIED,
        "source": "LCD cross-check 2026-08-11",
        "display": True,
    },
    {
        "key": "battery_soc",
        "name": "Battery SOC",
        "address": 33139,
        "count": 1,
        "function": 4,
        "data_type": "u16",
        "scale": 1.0,
        "unit": "%",
        "state": VERIFIED,
        "source": "ESINV-33000ID protocol",
        "display": True,
    },
    {
        "key": "battery_soh",
        "name": "Battery SOH",
        "address": 33140,
        "count": 1,
        "function": 4,
        "data_type": "u16",
        "scale": 1.0,
        "unit": "%",
        "state": VERIFIED,
        "source": "ESINV-33000ID protocol",
        "display": True,
    },
    {
        "key": "bms_voltage",
        "name": "BMS Voltage",
        "address": 33141,
        "count": 1,
        "function": 4,
        "data_type": "u16",
        "scale": 0.01,
        "unit": "V",
        "state": DOCUMENTED,
        "source": "ESINV-33000ID protocol",
        "display": False,
    },
    {
        "key": "house_load",
        "name": "House Load",
        "address": 33147,
        "count": 1,
        "function": 4,
        "data_type": "u16",
        "scale": 1.0,
        "unit": "W",
        "state": DOCUMENTED,
        "source": "ESINV-33000ID protocol",
        "display": True,
    },
    {
        "key": "backup_load",
        "name": "Backup Load",
        "address": 33148,
        "count": 1,
        "function": 4,
        "data_type": "u16",
        "scale": 1.0,
        "unit": "W",
        "state": DOCUMENTED,
        "source": "ESINV-33000ID protocol",
        "display": False,
    },
    {
        "key": "battery_power",
        "name": "Battery Power",
        "address": 33149,
        "count": 2,
        "function": 4,
        "data_type": "s32",
        "scale": 1.0,
        "unit": "W",
        "state": DOCUMENTED,
        "source": "ESINV-33000ID protocol",
        "display": True,
    },
]

# Lookup helper
ALL_REGISTERS = IDENTIFICATION_REGISTERS + SENSOR_REGISTERS
REGISTERS_BY_KEY = {r["key"]: r for r in ALL_REGISTERS}

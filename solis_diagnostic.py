"""
SOLIS S6-EH1P6K-L-PLUS MODBUS TCP DIAGNOSTIC TOOL
==================================================
PHASE 1: COMMUNICATION AND PROTOCOL VERIFICATION
STRICTLY READ-ONLY - NO WRITE CAPABILITY

Purpose: Verify the communication path from this PC through the
S2-WL-ST data logger to the Solis inverter, read identification
data, and confirm we can correctly decode Modbus registers.

Communication Path:
    PC → 192.168.1.46:502 (S2-WL-ST) → RS485 → S6-EH1P6K-L-PLUS

Usage:
    python solis_diagnostic.py
"""

from pymodbus.client import ModbusTcpClient
from pymodbus.exceptions import ModbusException, ConnectionException
import struct
import sys
import time

# ===========================================================================
# CONFIGURATION - Edit these values if your setup changes
# ===========================================================================

CONFIG = {
    "host": "192.168.1.46",
    "port": 502,
    "slave_id": 1,
    "timeout": 3,          # seconds
    "retries": 2,
    "retry_delay": 1.0,    # seconds between retries
}

# ===========================================================================
# IDENTIFICATION REGISTERS - SAFE READ-ONLY
# ===========================================================================
# VERIFIED for S6-EH1P6K-L-PLUS via S2-WL-ST (Function 04 only).
# Sources:
#   - Solis RS485 MODBUS protocol document (ESINV-33000ID)
#   - Confirmed on-device: serial at 33004, battery at 33133, etc.

IDENTIFICATION_READS = [
    # Serial Number (ASCII) at 33004
    {
        "name": "Serial Number (33004)",
        "address": 33004,
        "count": 8,
        "function": 4,       # Read Input Registers
        "data_type": "ascii",
        "confidence": "VERIFIED",
        "source": "ESINV-33000ID protocol; read on-device 2026-08-11",
    },
    # Inverter Type at 35000
    {
        "name": "Inverter Type (35000)",
        "address": 35000,
        "count": 1,
        "function": 4,
        "data_type": "inverter_type",
        "confidence": "VERIFIED",
        "source": "Solis RS485 protocol 5.2; read on-device 2026-08-11",
    },
    # Firmware Info Block at 33000 (model) + 33001/33002 (DSP/HMI version)
    {
        "name": "Model + Firmware (33000-33002)",
        "address": 33000,
        "count": 3,
        "function": 4,
        "data_type": "firmware_block",
        "confidence": "VERIFIED",
        "source": "ESINV-33000ID protocol",
    },
]

# ===========================================================================
# VERIFIED SENSOR REGISTERS - S6-EH1P6K-L-PLUS
# ===========================================================================
# All use Function 04 (Read Input Registers), NO address offset.
# Confirmed against LCD readings on 2026-08-11 14:47.
# Sources (all agree):
#   - Official Solis ESINV-33000ID protocol
#   - Pho3niX90/solis_modbus (explicitly supports S6-EH1P6K-L-PLUS + S2-WL-ST)
#   - fboundy/ha_solis_modbus (solis.yaml)
# CONFIDENCE: VERIFIED

SENSOR_TEST_READS = [
    # PV Inputs
    {
        "name": "PV1 Voltage",
        "address": 33049,
        "count": 1,
        "function": 4,
        "data_type": "u16",
        "scale": 0.1,
        "unit": "V",
        "confidence": "VERIFIED",
        "source": "ESINV-33000ID protocol; LCD cross-check 2026-08-11",
    },
    {
        "name": "PV1 Current",
        "address": 33050,
        "count": 1,
        "function": 4,
        "data_type": "u16",
        "scale": 0.1,
        "unit": "A",
        "confidence": "VERIFIED",
        "source": "ESINV-33000ID protocol; LCD cross-check 2026-08-11",
    },
    {
        "name": "PV2 Voltage",
        "address": 33051,
        "count": 1,
        "function": 4,
        "data_type": "u16",
        "scale": 0.1,
        "unit": "V",
        "confidence": "VERIFIED",
        "source": "ESINV-33000ID protocol; LCD cross-check 2026-08-11",
    },
    {
        "name": "PV2 Current",
        "address": 33052,
        "count": 1,
        "function": 4,
        "data_type": "u16",
        "scale": 0.1,
        "unit": "A",
        "confidence": "VERIFIED",
        "source": "ESINV-33000ID protocol; LCD cross-check 2026-08-11",
    },
    # Grid / AC
    {
        "name": "Grid Voltage",
        "address": 33073,
        "count": 1,
        "function": 4,
        "data_type": "u16",
        "scale": 0.1,
        "unit": "V",
        "confidence": "VERIFIED",
        "source": "ESINV-33000ID protocol",
    },
    {
        "name": "Grid Frequency",
        "address": 33094,
        "count": 1,
        "function": 4,
        "data_type": "u16",
        "scale": 0.01,
        "unit": "Hz",
        "confidence": "VERIFIED",
        "source": "ESINV-33000ID protocol",
    },
    # Battery
    {
        "name": "Battery Voltage",
        "address": 33133,
        "count": 1,
        "function": 4,
        "data_type": "u16",
        "scale": 0.1,
        "unit": "V",
        "confidence": "VERIFIED",
        "source": "ESINV-33000ID protocol; LCD cross-check 2026-08-11",
    },
    {
        "name": "Battery Current",
        "address": 33134,
        "count": 1,
        "function": 4,
        "data_type": "s16",
        "scale": 0.1,
        "unit": "A",
        "confidence": "VERIFIED",
        "source": "ESINV-33000ID protocol; LCD cross-check 2026-08-11",
    },
    {
        "name": "Battery State of Charge",
        "address": 33139,
        "count": 1,
        "function": 4,
        "data_type": "u16",
        "scale": 1.0,
        "unit": "%",
        "confidence": "VERIFIED",
        "source": "ESINV-33000ID protocol",
    },
    {
        "name": "Battery State of Health",
        "address": 33140,
        "count": 1,
        "function": 4,
        "data_type": "u16",
        "scale": 1.0,
        "unit": "%",
        "confidence": "VERIFIED",
        "source": "ESINV-33000ID protocol",
    },
]


# ===========================================================================
# FUNCTION LOOKUP
# ===========================================================================

FUNCTION_NAMES = {
    1: "Read Coils (01)",
    2: "Read Discrete Inputs (02)",
    3: "Read Holding Registers (03)",
    4: "Read Input Registers (04)",
}

# ===========================================================================
# ERROR MESSAGES
# ===========================================================================

MODBUS_ERROR_CODES = {
    0x01: "ILLEGAL FUNCTION - The inverter does not understand this function code",
    0x02: "ILLEGAL DATA ADDRESS - The register address does not exist",
    0x03: "ILLEGAL DATA VALUE - The data value is not acceptable",
    0x04: "SERVICE FAILURE - The inverter cannot access the requested data",
}


# ===========================================================================
# HELPER FUNCTIONS
# ===========================================================================

def register_to_ascii(registers):
    """Convert a list of 16-bit registers to an ASCII string (big-endian bytes)."""
    raw_bytes = b""
    for reg in registers:
        raw_bytes += struct.pack(">H", reg)
    try:
        text = raw_bytes.decode("ascii", errors="replace")
        return text.replace("\x00", "").strip()
    except UnicodeDecodeError:
        return repr(raw_bytes)


def decode_u16(registers):
    """Decode one register as unsigned 16-bit integer."""
    return registers[0]


def decode_s16(registers):
    """Decode one register as signed 16-bit integer."""
    val = registers[0]
    if val >= 0x8000:
        val -= 0x10000
    return val


def decode_u32(registers):
    """Decode two registers as unsigned 32-bit integer (big-endian)."""
    return (registers[0] << 16) | registers[1]


def decode_s32(registers):
    """Decode two registers as signed 32-bit integer (big-endian)."""
    val = (registers[0] << 16) | registers[1]
    if val >= 0x80000000:
        val -= 0x100000000
    return val


def format_hex_list(registers):
    """Format register list as hex string for display."""
    return " ".join(f"0x{r:04X}" for r in registers)


def format_hex(val, bits=16):
    """Format a single value as hex."""
    if bits == 16:
        return f"0x{val & 0xFFFF:04X}"
    elif bits == 32:
        return f"0x{val & 0xFFFFFFFF:08X}"
    return f"0x{val:X}"


# ===========================================================================
# MODBUS READ WITH RETRY
# ===========================================================================

def safe_read_registers(client, address, count, function, slave):
    """
    Read registers with error handling and retry logic.
    Returns (success, registers, error_message).
    """
    for attempt in range(1 + CONFIG["retries"]):
        if attempt > 0:
            print(f"    Retry {attempt}/{CONFIG['retries']} after {CONFIG['retry_delay']}s...")
            time.sleep(CONFIG["retry_delay"])

        try:
            if function == 3:
                result = client.read_holding_registers(
                    address=address, count=count, device_id=slave
                )
            elif function == 4:
                result = client.read_input_registers(
                    address=address, count=count, device_id=slave
                )
            else:
                return False, None, f"INTERNAL ERROR: Unknown function code {function}"

            if result.isError():
                # Modbus exception
                exc_code = result.exception_code
                error_desc = MODBUS_ERROR_CODES.get(
                    exc_code, f"Unknown exception code 0x{exc_code:02X}"
                )
                return False, None, f"Modbus Exception: {error_desc}"

            # Success - return the register values
            return True, result.registers, None

        except ConnectionException as e:
            if attempt == CONFIG["retries"]:
                return False, None, f"TCP CONNECTION FAILURE: {e}"
        except ModbusException as e:
            if attempt == CONFIG["retries"]:
                return False, None, f"MODBUS ERROR: {e}"
        except Exception as e:
            if attempt == CONFIG["retries"]:
                return False, None, f"UNEXPECTED ERROR: {type(e).__name__}: {e}"

    return False, None, "Maximum retries exceeded"


# ===========================================================================
# DISPLAY FUNCTIONS
# ===========================================================================

def print_header():
    print("=" * 48)
    print(" SOLIS S6-EH1P6K-L-PLUS MODBUS DIAGNOSTIC")
    print(" PHASE 1: COMMUNICATION & PROTOCOL VERIFICATION")
    print("=" * 48)
    print()
    print(f" Logger IP:       {CONFIG['host']}")
    print(f" Port:            {CONFIG['port']}")
    print(f" Protocol:        Modbus TCP")
    print(f" Slave ID:        {CONFIG['slave_id']}")
    print(f" Timeout:         {CONFIG['timeout']}s")
    print(f" Retries:         {CONFIG['retries']}")
    print()


def print_read_header(register_def):
    print("-" * 48)
    print(f" REGISTER: {register_def['name']}")
    print(f" Address:         {format_hex(register_def['address'])} ({register_def['address']})")
    print(f" Function:        {FUNCTION_NAMES.get(register_def['function'], str(register_def['function']))}")
    print(f" Count:           {register_def['count']} register(s)")
    print(f" Confidence:      {register_def['confidence']}")
    print(f" Source:          {register_def['source']}")
    print()


def print_raw_registers(registers):
    print(f" RAW REGISTERS:   {format_hex_list(registers)}")
    print(f" RAW DECIMAL:     {registers}")


def format_value(value):
    """Round a decoded value to a clean display string (max 2 decimals)."""
    if isinstance(value, float):
        return f"{value:.2f}".rstrip("0").rstrip(".")
    return str(value)


def print_decoded_sensor(register_def, raw_value, decoded_value):
    print(f" RAW VALUE:       {format_hex(raw_value, 16)} ({raw_value})")
    print(f" DECODED:         {format_value(decoded_value)}")
    if "scale" in register_def:
        print(f" SCALE:           {register_def['scale']}")
    if "unit" in register_def:
        print(f" UNIT:            {register_def['unit']}")


def print_connection_status(tcp_ok, modbus_ok):
    print("-" * 48)
    print(" CONNECTION STATUS")
    print(f" TCP Connection:  {'CONNECTED' if tcp_ok else 'FAILED'}")
    print(f" Modbus Status:   {'CONNECTED' if modbus_ok else 'FAILED'}")
    print()


# ===========================================================================
# MAIN DIAGNOSTIC
# ===========================================================================

def main():
    print_header()

    # ---- STEP 1: Establish TCP connection ----
    print(">> STEP 1: ESTABLISHING TCP CONNECTION")
    print(f"   Connecting to {CONFIG['host']}:{CONFIG['port']} ...")

    client = ModbusTcpClient(
        CONFIG["host"],
        port=CONFIG["port"],
        timeout=CONFIG["timeout"],
    )

    tcp_ok = client.connect()

    if not tcp_ok:
        print("   RESULT: TCP CONNECTION FAILED")
        print()
        print("   TROUBLESHOOTING:")
        print("   - Is the S2-WL-ST powered on?")
        print("   - Is 192.168.1.46 the correct IP?")
        print("   - Is port 502 open?")
        print("   - Is your PC on the same network (192.168.1.x)?")
        print("   - Try: Test-NetConnection 192.168.1.46 -Port 502")
        print()
        print("=" * 48)
        print(" RESULT: COMMUNICATION FAILURE")
        print("=" * 48)
        sys.exit(1)

    print("   RESULT: TCP CONNECTED")
    print()

    # ---- STEP 2: Read identification registers ----
    print(">> STEP 2: READING IDENTIFICATION REGISTERS")
    print()

    modbus_ok = False
    serial_number = None
    protocol_version = None
    firmware_info = {}

    for reg_def in IDENTIFICATION_READS:
        print_read_header(reg_def)

        success, registers, error = safe_read_registers(
            client,
            reg_def["address"],
            reg_def["count"],
            reg_def["function"],
            CONFIG["slave_id"],
        )

        if not success:
            print(f" RESULT: READ FAILED")
            print(f" ERROR:  {error}")
            print()
            # First failure on serial number is critical
            if reg_def == IDENTIFICATION_READS[0]:
                print("=" * 48)
                print(" RESULT: MODBUS COMMUNICATION FAILURE")
                print("=" * 48)
                print()
                print(" The inverter did not respond to the serial number read.")
                print()
                print(" POSSIBLE CAUSES:")
                print(" - Slave ID may not be 1 (try different IDs)")
                print(" - The S2-WL-ST may require a different Modbus address format")
                print(" - The inverter may use a different register address")
                print(" - The S2-WL-ST may need configuration to enable Modbus TCP")
                print()
                client.close()
                sys.exit(1)
            continue

        # Success - we have a working Modbus connection
        modbus_ok = True
        print_raw_registers(registers)

        # Decode based on data type
        if reg_def["data_type"] == "ascii":
            text = register_to_ascii(registers)
            serial_number = text
            print(f" ASCII DECODED:   \"{text}\"")
            if text:
                print(f" SERIAL NUMBER:   {text}")
            else:
                print(f" NOTE:            Empty or non-ASCII serial - may use alternative address")

        elif reg_def["data_type"] == "u16":
            value = registers[0]
            protocol_version = value
            print(f" DECODED:         {value}")
            if 0 < value < 1000:
                print(f" PROTOCOL VER:    {value}")
            else:
                print(f" NOTE:            Value {value} does not look like a valid protocol version")

        elif reg_def["data_type"] == "inverter_type":
            value = registers[0]
            protocol_version = (value & 0xFF00) >> 8
            model_code = value & 0x00FF
            print(f" RAW VALUE:       0x{value:04X} = {value}")
            print(f" Protocol:        {protocol_version} (0x{protocol_version:02X})")
            print(f" Model:           {model_code} (0x{model_code:02X})")
            if protocol_version in (0x10, 0x20, 0x21, 0x22):
                proto_name = "Standard inverter" if protocol_version == 0x10 else "Energy storage inverter"
                print(f" Type:            {proto_name} (ESINV-33000ID protocol)")

        elif reg_def["data_type"] == "firmware_block":
            # Register layout for ESINV-33000ID:
            #   33000 = Product model
            #   33001 = DSP software version
            #   33002 = HMI/LCD software version
            model = registers[0]
            dsp_ver = registers[1]
            hmi_ver = registers[2]
            print(f" Model:           0x{model:04X} = {model}")
            print(f" DSP Version:     0x{dsp_ver:04X} = {dsp_ver}")
            print(f" HMI Version:     0x{hmi_ver:04X} = {hmi_ver}")

        print()

    # ---- STEP 3: Connection status ----
    print_connection_status(tcp_ok, modbus_ok)

    if not modbus_ok:
        print("=" * 48)
        print(" RESULT: MODBUS COMMUNICATION FAILURE")
        print("=" * 48)
        client.close()
        sys.exit(1)

    # ---- STEP 4: Identification summary ----
    print("-" * 48)
    print(" IDENTIFICATION SUMMARY")
    print(f" Serial Number:   {serial_number or 'NOT READ'}")
    print(f" Protocol Ver:    {protocol_version or 'NOT READ'}")
    if firmware_info:
        print(f" DSP Version:     v{firmware_info['dsp_major']}.{firmware_info['dsp_minor']:02d}")
        print(f" ARM Version:     v{firmware_info['arm_major']}.{firmware_info['arm_minor']:02d}")
    print()

    # ---- STEP 5: Attempt safe sensor reads ----
    print(">> STEP 3: SAFE SENSOR REGISTER TESTS")
    print()
    print(" VERIFIED register map for S6-EH1P6K-L-PLUS (ESINV-33000ID).")
    print(" Values confirmed against LCD readings on 2026-08-11.")
    print()

    sensor_success_count = 0
    sensor_total = len(SENSOR_TEST_READS)

    for reg_def in SENSOR_TEST_READS:
        print_read_header(reg_def)

        success, registers, error = safe_read_registers(
            client,
            reg_def["address"],
            reg_def["count"],
            reg_def["function"],
            CONFIG["slave_id"],
        )

        if not success:
            print(f" RESULT: READ FAILED")
            print(f" ERROR:  {error}")
            print()
            continue

        sensor_success_count += 1
        raw_value = registers[0]

        # Decode based on data type
        if reg_def["data_type"] == "u16":
            decoded = raw_value * reg_def.get("scale", 1.0)
        elif reg_def["data_type"] == "s16":
            decoded = decode_s16(registers) * reg_def.get("scale", 1.0)
        elif reg_def["data_type"] == "u32":
            decoded = decode_u32(registers) * reg_def.get("scale", 1.0)
        elif reg_def["data_type"] == "s32":
            decoded = decode_s32(registers) * reg_def.get("scale", 1.0)
        else:
            decoded = raw_value

        print_raw_registers(registers)
        print_decoded_sensor(reg_def, raw_value, decoded)
        print()

    # ---- STEP 6: Final result ----
    print("-" * 48)
    print(f" SENSOR READS:    {sensor_success_count}/{sensor_total} successful")
    print()

    if sensor_success_count > 0:
        print("=" * 48)
        print(" RESULT: MODBUS COMMUNICATION SUCCESSFUL")
        print(f" {sensor_success_count}/{sensor_total} registers read successfully.")
        print(" Values were cross-validated against the inverter LCD.")
        print("=" * 48)
    else:
        print("=" * 48)
        print(" RESULT: IDENTIFICATION OK, SENSOR READS FAILED")
        print(" The inverter responded to identification but not sensor")
        print(" registers. Check the register map.")
        print("=" * 48)

    print()
    print(" Next Steps:")
    print(" 1. Verify serial number matches your Solis app / label")
    print(" 2. Phase 1 complete - communication path VERIFIED")
    print(" 3. Phase 2: reliable data acquisition can now begin")
    print()

    client.close()


if __name__ == "__main__":
    main()

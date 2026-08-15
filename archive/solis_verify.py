"""
SOLIS S6-EH1P6K-L-PLUS - REGISTER VERIFICATION SCAN
User-reported live values (14:47-14:48):
  PV1: 293.6V, 2.9A
  PV2: 123.9V, 2.9A
  Battery: 54.2V, 0.0A
  Grid: 0.0V
We scan all working registers and flag matches to these values.
"""
from pymodbus.client import ModbusTcpClient
import struct
import time

client = ModbusTcpClient("192.168.1.46", port=502, timeout=3)
client.connect()

# Known physical values for matching
EXPECTED = {
    2936: "PV1 VOLTAGE 293.6V (x0.1)",
    1239: "PV2 VOLTAGE 123.9V (x0.1)",
    542:  "BATTERY VOLTAGE 54.2V (x0.1)",
    29:   "PV CURRENT 2.9A (x0.1)",
    0:    "GRID VOLTAGE 0.0V",
}

# Scan broad 33000+ region in blocks of 20
print("Scanning 33003..33500 ...")
found = {}
full = {}

start = 0x80EB
end = 0x8303  # 33500
step = 20

addr = start
while addr <= end:
    try:
        res = client.read_input_registers(address=addr, count=step, device_id=1)
        if not res.isError():
            for i, r in enumerate(res.registers):
                full[addr + i] = r
                if r in EXPECTED and r != 0:
                    tag = EXPECTED[r]
                    key = tag
                    found.setdefault(key, []).append(addr + i)
        else:
            pass
    except Exception:
        pass
    addr += step

# Print matches
print("\n=== MATCHES to user-reported values ===")
for tag, addrs in sorted(found.items()):
    print(f"  {tag}:")
    for a in addrs:
        print(f"    register {a} (0x{a:04X}) = {full[a]}")

# Print the full map in a compact format for review
print("\n=== FULL MAP (non-zero only) ===")
base = 33000
for a in sorted(full):
    r = full[a]
    if r != 0:
        print(f"  {a} (0x{a:04X}): {r}")

client.close()

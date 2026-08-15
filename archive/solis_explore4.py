"""Decode and scan energy storage register map."""
from pymodbus.client import ModbusTcpClient
import struct

client = ModbusTcpClient("192.168.1.100", port=502, timeout=3)
client.connect()

# Decode existing data properly
res = client.read_input_registers(address=0x80EB, count=40, device_id=1)
if not res.isError():
    regs = res.registers
    print("=== Serial Number (33003-33012) ===")
    raw_bytes = b""
    for r in regs[1:9]:
        raw_bytes += struct.pack(">H", r)
    sn = raw_bytes.decode("ascii", errors="replace")
    sn = sn.replace("\x00", "")
    print(f"  Full SN: {sn}")
    print(f"  Header: 0x{regs[0]:04X}")

    print("\n=== Possible Metadata (33019-33030) ===")
    for i in range(16, 28):
        print(f"  3300{i+3} (offset +{i}):  0x{regs[i]:04X} = {regs[i]:5d}")

# Now scan for live sensor data
# Looking for values that would make sense:
# PV voltage: ~200-500V (2000-5000 at 0.1V scale)
# Grid voltage: ~230V (2300 at 0.1V scale)
# Power: ~0-6000W
# Battery SoC: 0-100%

# Try known energy storage register offsets
# The protocol doc says ESINV uses 33000 base
# Try reading various blocks
print("\n=== Scanning for operational data ===")
scan_ranges = [
    (0x80E7, 8, "33000+"),      # already tried, fails at 33000
    (0x80EB + 30, 20, "33033+"),
    (0x80EB + 50, 20, "33053+"),
    (0x80EB + 70, 20, "33073+"),
    (0x80EB + 90, 20, "33093+"),
    (0x80EB + 110, 20, "33113+"),
    (0x80EB + 130, 20, "33133+"),
    (0x80EB + 170, 20, "33173+"),
    (0x80EB + 200, 20, "33203+"),
    (0x80EB + 250, 20, "33253+"),
    (0x80EB + 300, 20, "33303+"),
    # Also try 33500+ range
    (0x82E3, 20, "33500+"),     # 33500
]

for addr, cnt, label in scan_ranges:
    res = client.read_input_registers(address=addr, count=cnt, device_id=1)
    if res.isError():
        print(f"  {label}: ERROR 0x{res.exception_code:02X}")
    else:
        regs = res.registers
        # Only print if there are non-zero values
        non_zero = [(i, r) for i, r in enumerate(regs) if r != 0]
        if non_zero:
            print(f"  {label}: {len(non_zero)} non-zero values")
            for idx, val in non_zero[:8]:
                print(f"    +{idx:3d}: 0x{val:04X} = {val}")
        else:
            print(f"  {label}: all zeros")

client.close()

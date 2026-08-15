"""Deep exploration - decode the working 33000+ address range."""
from pymodbus.client import ModbusTcpClient
import struct

client = ModbusTcpClient("192.168.1.46", port=502, timeout=3)
client.connect()

# Read a large block from the 33000 area
print("=== Continuous block read from 33003 (0x80EB) ===")
res = client.read_input_registers(address=0x80EB, count=60, device_id=1)
if not res.isError():
    regs = res.registers
    print(f"  Count: {len(regs)} registers")
    for i in range(0, len(regs), 4):
        chunk = regs[i:i+4]
        addr = 0x80EB + i
        hexstr = " ".join(f"0x{r:04X}" for r in chunk)
        raw = b"".join(struct.pack(">H", r) for r in chunk)
        asc = raw.decode("ascii", errors="replace").replace("\x00", ".")
        print(f"  +{i:3d} (33003+{i:2d}) [{hexstr}] ascii=\"{asc}\"")
else:
    print(f"  ERROR 0x{res.exception_code:02X}")

# Try 33000-33002 individually
print("\n=== Individual reads 33000-33002 ===")
for addr in [0x80E7, 0x80E8, 0x80E9, 0x80EA]:
    res = client.read_input_registers(address=addr, count=1, device_id=1)
    if res.isError():
        print(f"  0x{addr:04X} (3300{addr-0x80E7}): ERROR 0x{res.exception_code:02X}")
    else:
        print(f"  0x{addr:04X} (3300{addr-0x80E7}): 0x{res.registers[0]:04X} = {res.registers[0]}")

# Read from 35000 with larger count
print("\n=== Block read from 35000 (0x88B8) ===")
res = client.read_input_registers(address=0x88B8, count=10, device_id=1)
if not res.isError():
    regs = res.registers
    for i, r in enumerate(regs):
        print(f"  35000+{i}: 0x{r:04X} = {r}")
else:
    print(f"  ERROR 0x{res.exception_code:02X}")

client.close()

"""Deep exploration of working Modbus address ranges."""
from pymodbus.client import ModbusTcpClient
import struct

client = ModbusTcpClient("192.168.1.100", port=502, timeout=3)
client.connect()

def to_ascii(regs):
    """Convert registers to ASCII string."""
    raw = b"".join(struct.pack(">H", r) for r in regs)
    try:
        return raw.decode("ascii", errors="replace").replace("\x00", "").strip()
    except:
        return repr(raw)

# Explore 33000-33030 range (energy storage base)
print("=== Energy Storage Base (0x80E7+) ===")
for start in range(0x80E7, 0x8107, 4):
    res = client.read_input_registers(address=start, count=4, device_id=1)
    if res.isError():
        pass  # skip errors for now
    else:
        regs = res.registers
        hexstr = " ".join(f"0x{r:04X}" for r in regs)
        asc = to_ascii(regs)
        print(f"  0x{start:04X} ({start}): [{hexstr}] ascii=\"{asc}\"")

# Explore 35000 range
print("\n=== 35000 range (0x88B0+) ===")
for start in range(0x88B0, 0x88C0, 1):
    res = client.read_input_registers(address=start, count=1, device_id=1)
    if res.isError():
        pass
    else:
        r = res.registers[0]
        print(f"  0x{start:04X} ({start}): 0x{r:04X} = {r}")

# Try 0x1A10 for serial (homeassistant-solax-modbus GEN6)
print("\n=== Alternative serial locations ===")
for loc in [0x1A10, 0x300, 0x000]:
    for func in [4, 3]:
        if func == 3:
            res = client.read_holding_registers(address=loc, count=7, device_id=1)
        else:
            res = client.read_input_registers(address=loc, count=7, device_id=1)
        if not res.isError():
            regs = res.registers
            hexstr = " ".join(f"0x{r:04X}" for r in regs)
            asc = to_ascii(regs)
            print(f"  0x{loc:04X} F{func}: [{hexstr}] ascii=\"{asc}\"")
        else:
            print(f"  0x{loc:04X} F{func}: ERROR 0x{res.exception_code:02X}")

client.close()

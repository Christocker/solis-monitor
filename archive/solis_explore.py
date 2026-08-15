"""Quick exploration of working Modbus register ranges."""
from pymodbus.client import ModbusTcpClient

client = ModbusTcpClient("192.168.1.46", port=502, timeout=3)
client.connect()

# Register 35000 (0x88B8) with Function 04 works.
# Let's explore nearby and find the active address map.

tests = [
    # Near 35000 - explore surroundings
    (4, 0x88B7, 1, "35000-1(F4)"),
    (4, 0x88B8, 4, "35000+3(F4)"),
    (4, 0x88B9, 2, "35001+1(F4)"),
    (4, 0x88BB, 2, "35003+1(F4)"),
    (4, 0x88BF, 2, "35007+1(F4)"),
    # Try Function 03 near 35000
    (3, 0x88B8, 1, "35000(F3)"),
    # Energy storage protocol - addresses start at 33000+ (offset -1)
    (4, 0x80E7, 4, "33000(F4)"),
    (4, 0x80EB, 4, "33004(F4)"),
    # Try higher addresses in blocks
    (4, 0x2000, 4, "0x2000(F4)"),
    (4, 0x4000, 4, "0x4000(F4)"),
    (4, 0x6000, 4, "0x6000(F4)"),
    (4, 0x8000, 4, "0x8000(F4)"),
    (4, 0xA000, 4, "0xA000(F4)"),
    (4, 0xC000, 4, "0xC000(F4)"),
    # Also try standard protocol addresses
    (4, 0x0BB7, 2, "3000(F4)"),
    (4, 0x0BC1, 2, "3010(F4)"),
    (4, 0x0BC2, 2, "3011(F4)"),
    # Function 03 with known addresses
    (3, 0x0BB7, 2, "3000(F3)"),
    (3, 0x2000, 4, "0x2000(F3)"),
    (3, 0x4000, 4, "0x4000(F3)"),
    (3, 0x8000, 4, "0x8000(F3)"),
    (3, 0xA000, 4, "0xA000(F3)"),
]

for func, addr, cnt, name in tests:
    if func == 3:
        res = client.read_holding_registers(address=addr, count=cnt, device_id=1)
    else:
        res = client.read_input_registers(address=addr, count=cnt, device_id=1)

    if res.isError():
        print(f"  {name}: ERROR exc=0x{res.exception_code:02X}")
    else:
        regs = res.registers
        hexstr = " ".join(f"0x{r:04X}" for r in regs[:min(4, len(regs))])
        print(f"  {name}: OK [{hexstr}]")

client.close()

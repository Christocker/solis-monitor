"""
Scan 33500-37500 looking for PV voltage registers (2936, 1239, 29).
"""
from pymodbus.client import ModbusTcpClient

client = ModbusTcpClient("192.168.1.46", port=502, timeout=3)
client.connect()

EXPECTED = {
    2936: "PV1 VOLTAGE 293.6V",
    1239: "PV2 VOLTAGE 123.9V",
    29:   "PV CURRENT 2.9A",
}

found = {}
full = {}

start = 0x8303  # 33500
end = 0x927C   # 37500
step = 20

addr = start
while addr <= end:
    try:
        res = client.read_input_registers(address=addr, count=step, device_id=1)
        if not res.isError():
            for i, r in enumerate(res.registers):
                full[addr + i] = r
                if r in EXPECTED:
                    tag = EXPECTED[r]
                    found.setdefault(tag, []).append(addr + i)
        else:
            pass
    except Exception:
        pass
    addr += step

print("=== MATCHES ===")
for tag, addrs in sorted(found.items()):
    print(f"  {tag}: {[f'{a} (0x{a:04X})' for a in addrs]}")

if not found:
    print("  None found in 33500-37500")

# Print non-zero values found for review
print("\n=== NON-ZERO VALUES 33500-37500 ===")
count = 0
for a in sorted(full):
    r = full[a]
    if r != 0:
        print(f"  {a} (0x{a:04X}): {r}")
        count += 1
print(f"  ({count} non-zero values)")

client.close()

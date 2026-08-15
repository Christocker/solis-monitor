"""
Scan 37500-41000 and re-examine data blocks around battery voltage.
"""
from pymodbus.client import ModbusTcpClient

client = ModbusTcpClient("192.168.1.46", port=502, timeout=3)
client.connect()

EXPECTED = {
    2936: "PV1 VOLTAGE 293.6V",
    1239: "PV2 VOLTAGE 123.9V",
    29:   "PV CURRENT 2.9A",
    542:  "BATTERY VOLTAGE 54.2V",
}

found = {}
full = {}

# Scan 37500-41000
start = 0x927C  # 37500
end = 0xA028   # 41000
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
    except Exception:
        pass
    addr += step

print("=== MATCHES 37500-41000 ===")
for tag, addrs in sorted(found.items()):
    print(f"  {tag}: {[f'{a} (0x{a:04X})' for a in addrs]}")

print("\n=== NON-ZERO VALUES 37500-41000 ===")
count = 0
for a in sorted(full):
    r = full[a]
    if r != 0:
        print(f"  {a} (0x{a:04X}): {r}")
        count += 1
print(f"  ({count} non-zero values)")

# Now examine the block around 33133 (battery voltage) fully with zeros
print("\n=== FULL BLOCK 33125-33155 (around battery voltage) ===")
res = client.read_input_registers(address=0x8155, count=31, device_id=1)
if not res.isError():
    for i, r in enumerate(res.registers):
        a = 0x8155 + i
        print(f"  {a} (0x{a:04X}): {r}")

# And around 36044
print("\n=== FULL BLOCK 36030-36060 ===")
res = client.read_input_registers(address=0x8CBE, count=31, device_id=1)
if not res.isError():
    for i, r in enumerate(res.registers):
        a = 0x8CBE + i
        print(f"  {a} (0x{a:04X}): {r}")

client.close()

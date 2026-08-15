"""
SOLIS S6-EH1P6K-L-PLUS - FULL REGISTER SCAN
Reads all working registers in the 33000+ range.
Displays raw values for cross-referencing with Solis app.
"""
from pymodbus.client import ModbusTcpClient
import struct


def guess_meaning(offset, value):
    """Try to interpret register values based on typical inverter data."""
    if offset == 16:
        return "metadata: 0"
    if offset == 17:
        return "count/type = 1"
    if offset == 18:
        return "dsp_type = 4"
    if offset == 19:
        return "param = 26"
    if offset == 20:
        return "param = 8"
    if offset == 21:
        return "param = 11"
    if offset == 22:
        return "param = 14"
    if offset == 23:
        return "param = 43"
    if offset == 24:
        return "param = 58"
    if offset == 27:
        return "model_code = 835"
    if 0 <= value <= 100 and offset > 50:
        return f"POSSIBLE SoC: {value}%"
    if 2000 <= value <= 2600 and offset > 50:
        return f"POSSIBLE VOLTAGE: {value*0.1:.1f}V"
    if 300 <= value <= 600 and offset > 50:
        return f"POSSIBLE PV V: {value*0.1:.1f}V"
    if 500 <= value <= 6000 and offset > 50:
        return f"possible power: {value}W"
    if 50 <= value <= 1500 and offset > 50:
        return f"temp? {value*0.1:.1f}C"
    if 4900 <= value <= 5100:
        return f"POSSIBLE FREQ: {value*0.01:.2f}Hz"
    return f"raw={value}"


client = ModbusTcpClient("192.168.1.46", port=502, timeout=3)
client.connect()

print("=" * 72)
print(" SOLIS S6-EH1P6K-L-PLUS MODBUS REGISTER SCAN")
print("=" * 72)

# Read inverter type
res = client.read_input_registers(address=0x88B8, count=1, device_id=1)
inv_type = res.registers[0] if not res.isError() else None
print(f"\n Inverter Type (35000):  0x{inv_type:04X} = {inv_type}")
print(f"   Protocol: 0x{(inv_type & 0xFF00) >> 8:02X} = {(inv_type & 0xFF00) >> 8}")
print(f"   Model:    0x{inv_type & 0x00FF:02X} = {inv_type & 0x00FF}")

# Read serial number
res = client.read_input_registers(address=0x80EB, count=9, device_id=1)
if not res.isError():
    sn_header = res.registers[0]
    raw = b"".join(struct.pack(">H", r) for r in res.registers[1:9])
    sn = raw.decode("ascii", errors="replace").replace("\x00", "").strip()
    print(f"\n Serial Number:         {sn}")
    print(f"   Header:              0x{sn_header:04X}")

# Read large block of operational data
# Start after serial number metadata
print("\n" + "=" * 72)
print(" OPERATIONAL REGISTERS (33033 to 33253)")
print("=" * 72)

# Read in blocks of 20 at a time
all_regs = []
for block_start in range(0, 300, 20):
    addr = 0x80EB + 30 + block_start
    res = client.read_input_registers(address=addr, count=20, device_id=1)
    if not res.isError():
        all_regs.extend(res.registers)
    else:
        break  # Stop at first error

regs = all_regs
base = 33003 + 30  # 33033

print(f"\n {'Offset':>8} {'Register':>8} {'Hex':>8} {'Decimal':>8} {'Possible Meaning':>30}")
print(f" {'-'*8} {'-'*8} {'-'*8} {'-'*8} {'-'*30}")

for i, r in enumerate(regs):
    if r == 0:
        continue
    if i == 0:
        print(f" ... (skipping zeros, showing non-zero values only) ...")
    addr = base + i
    hexstr = f"0x{r:04X}"
    decstr = str(r)
    meaning = guess_meaning(i, r)
    print(f" {i:>8d} {addr:>8d} {hexstr:>8} {decstr:>8} {meaning:>30}")

client.close()

def guess_meaning(offset, value):
    """Try to interpret register values based on typical inverter data."""
    # These are guesses based on the energy storage protocol convention
    # CONFIDENCE: LOW - these are educated guesses only
    
    # Metadata block (offsets 16-27)
    if offset == 16:
        return "metadata: 0"
    if offset == 17:
        return "count/type = 1"
    if offset == 18:
        return "dsp_type = 4"
    if offset == 19:
        return "param = 26"
    if offset == 20:
        return "param = 8"
    if offset == 21:
        return "param = 11"
    if offset == 22:
        return "param = 14"
    if offset == 23:
        return "param = 43"
    if offset == 24:
        return "param = 58"
    if offset == 25:
        return "param = 0"
    if offset == 26:
        return "param = 0"
    if offset == 27:
        return "model_code = 835"
    
    # Operational data guesses
    if offset == 31:
        return f"val={value} (480)"
    if offset == 32:
        return f"val={value} (148)"
    if offset == 33:
        return f"val={value} (177)"
    if offset == 35:
        return f"val={value} (834)"
    if offset == 38:
        return f"temp? {value} => {value*0.1:.1f} degC"
    if offset == 41:
        return f"power? {value}W"
    if offset == 45:
        return f"status = {value}"
    if offset == 46:
        return f"total energy? {value} = {value*0.1:.1f} kWh"
    
    # Values that look like battery SoC
    if 0 <= value <= 100 and offset > 50:
        return f"** POSSIBLE SoC: {value}% **"
    
    # Values that look like voltage (200-600 range at scale 0.1V = 20-60V raw)
    # or 2200-2500 range (220-250V at scale 0.1)
    if 2000 <= value <= 2600 and offset > 50:
        return f"** POSSIBLE VOLTAGE: {value*0.1:.1f}V **"
    if 300 <= value <= 600 and offset > 50:
        return f"** POSSIBLE PV V: {value*0.1:.1f}V **"
    
    # Values that look like power (500-6000W range)
    if 500 <= value <= 6000 and offset > 50:
        return f"possible power: {value}W"
    
    # Values that look like temperature
    if 50 <= value <= 1500 and offset > 50:
        return f"temp? {value*0.1:.1f} degC"
    
    # Values that look like frequency (4900-5100 = 49-51Hz at scale 0.01)
    if 4900 <= value <= 5100:
        return f"** POSSIBLE FREQ: {value*0.01:.2f}Hz **"
    
    return f"raw={value}"

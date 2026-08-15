"""
SOLIS S6-EH1P6K-L-PLUS - VERIFIED REGISTER READ
Reads the confirmed S6-EH1P register map (ESINV-33000ID protocol).
All Function 04 (Input Registers), no offset.
"""
from pymodbus.client import ModbusTcpClient
import struct

client = ModbusTcpClient("192.168.1.46", port=502, timeout=3)
client.connect()


def rd_u16(addr, name):
    res = client.read_input_registers(address=addr, count=1, device_id=1)
    if res.isError():
        return f"ERROR 0x{res.exception_code:02X}"
    return res.registers[0]


def rd_u32(addr, name):
    res = client.read_input_registers(address=addr, count=2, device_id=1)
    if res.isError():
        return f"ERROR 0x{res.exception_code:02X}"
    return (res.registers[0] << 16) | res.registers[1]


def rd_s32(addr, name):
    res = client.read_input_registers(address=addr, count=2, device_id=1)
    if res.isError():
        return f"ERROR 0x{res.exception_code:02X}"
    v = (res.registers[0] << 16) | res.registers[1]
    if v >= 0x80000000:
        v -= 0x100000000
    return v


def s16(v):
    if v >= 0x8000:
        return v - 0x10000
    return v


print("=" * 56)
print(" SOLIS S6-EH1P6K-L-PLUS VERIFIED REGISTER READ")
print("=" * 56)
print()

# --- DC / PV block ---
pv1v = rd_u16(33049, "PV1 V")
pv1i = rd_u16(33050, "PV1 I")
pv2v = rd_u16(33051, "PV2 V")
pv2i = rd_u16(33052, "PV2 I")
pv_power_total = rd_u32(33057, "PV P total")

print(" PV (DC) Inputs:")
print(f"   PV1 Voltage:    {pv1v}  ->  {pv1v * 0.1:.1f} V")
print(f"   PV1 Current:    {pv1i}  ->  {pv1i * 0.1:.2f} A")
print(f"   PV2 Voltage:    {pv2v}  ->  {pv2v * 0.1:.1f} V")
print(f"   PV2 Current:    {pv2i}  ->  {pv2i * 0.1:.2f} A")
print(f"   PV Power Total: {pv_power_total}  ->  {pv_power_total:.0f} W")
print()

# --- Grid / AC block ---
grid_v = rd_u16(33073, "Grid V")
grid_i = rd_u16(33076, "Grid I")
ac_power = rd_s32(33079, "AC power")
grid_freq = rd_u16(33094, "Grid freq")

print(" Grid / AC:")
print(f"   Grid Voltage:   {grid_v}  ->  {grid_v * 0.1:.1f} V")
print(f"   Grid Current:   {grid_i}  ->  {grid_i * 0.1:.2f} A")
print(f"   AC Power:       {ac_power} W")
print(f"   Grid Freq:      {grid_freq}  ->  {grid_freq * 0.01:.2f} Hz")
print()

# --- Battery block ---
bat_v = rd_u16(33133, "Batt V")
bat_i = rd_u16(33134, "Batt I")
bat_dir = rd_u16(33135, "Batt dir")
bat_soc = rd_u16(33139, "SOC")
bat_soh = rd_u16(33140, "SOH")
bms_v = rd_u16(33141, "BMS V")
house_load = rd_u16(33147, "House load")
backup_load = rd_u16(33148, "Backup load")
bat_power = rd_s32(33149, "Batt P")

print(" Battery (Dyness LV):")
print(f"   Battery Voltage:   {bat_v}  ->  {bat_v * 0.1:.1f} V")
print(f"   Battery Current:   {s16(bat_i)}  ->  {s16(bat_i) * 0.1:.2f} A")
print(f"   Battery Direction: {bat_dir}  (0=charge, 1=discharge)")
print(f"   Battery SOC:       {bat_soc} %")
print(f"   Battery SOH:       {bat_soh} %")
print(f"   BMS Voltage:       {bms_v}  ->  {bms_v * 0.01:.2f} V")
print(f"   House Load:        {house_load} W")
print(f"   Backup Load:       {backup_load} W")
print(f"   Battery Power:     {bat_power} W")
print()

client.close()

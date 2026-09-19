"""
Dashboard configuration.

Central place for connection settings and application settings.
The Phase 1 diagnostic tool keeps its own copy of these values so it
can remain fully independent.
"""

import os

# Modbus TCP connection to the S2-WL-ST data logger.
# The logger gets its address over DHCP, so it can move. Override without
# editing code by setting SOLIS_HOST / SOLIS_PORT in the environment
# (e.g. in the systemd unit or a .env file).
CONFIG = {
    "host": os.environ.get("SOLIS_HOST", "192.168.1.45"),
    "port": int(os.environ.get("SOLIS_PORT", "502")),
    "slave_id": int(os.environ.get("SOLIS_SLAVE_ID", "1")),
    "timeout": 3,          # seconds
    "retries": 2,
    "retry_delay": 1.0,    # seconds between retries
}

# How often the background poller reads the inverter (seconds)
POLL_INTERVAL = 2.0

# Optional LAN auto-discovery. The logger's DHCP lease can change (it has
# happened before), so if the configured host stops answering, the poller can
# scan the subnet for a Modbus device that answers the PV1-voltage register
# and adopt it. Disable with SOLIS_DISCOVERY=0.
DISCOVERY_ENABLED = os.environ.get("SOLIS_DISCOVERY", "1").lower() not in (
    "0", "false", "no", "off",
)
DISCOVERY_AFTER = float(os.environ.get("SOLIS_DISCOVERY_AFTER", "30"))     # s offline before scanning
DISCOVERY_INTERVAL = float(os.environ.get("SOLIS_DISCOVERY_INTERVAL", "300"))  # s between scans

# Grid is considered connected when grid voltage is above this threshold (V)
GRID_CONNECTED_THRESHOLD_V = 50.0

# Grid CO2 intensity used for the "CO2 avoided" estimate (kg CO2e per kWh).
# Default ~0.7 (typical grid); override with CO2_KG_PER_KWH.
CO2_KG_PER_KWH = float(os.environ.get("CO2_KG_PER_KWH", "0.7"))

# A mature tree absorbs roughly this many kg CO2 per year (for the equivalent).
CO2_KG_PER_TREE_YEAR = 21.0

# Web server
SERVER_HOST = "0.0.0.0"     # all interfaces so other devices on the LAN can connect
SERVER_PORT = 8080

# Optional DEMO mode. When True, the API serves clearly-labeled mock data
# instead of touching the inverter. NEVER enable this for production.
DEMO_MODE = False

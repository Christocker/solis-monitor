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

# Grid is considered connected when grid voltage is above this threshold (V)
GRID_CONNECTED_THRESHOLD_V = 50.0

# Web server
SERVER_HOST = "0.0.0.0"     # all interfaces so other devices on the LAN can connect
SERVER_PORT = 8080

# Optional DEMO mode. When True, the API serves clearly-labeled mock data
# instead of touching the inverter. NEVER enable this for production.
DEMO_MODE = False

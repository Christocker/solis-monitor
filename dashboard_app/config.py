"""
Dashboard configuration.

Central place for connection settings and application settings.
The Phase 1 diagnostic tool keeps its own copy of these values so it
can remain fully independent.
"""

# Modbus TCP connection to the S2-WL-ST data logger
CONFIG = {
    "host": "192.168.1.46",
    "port": 502,
    "slave_id": 1,
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

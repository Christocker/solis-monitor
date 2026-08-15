"""
solis-monitor dashboard package.

Layered architecture:
  Layer 1: dashboard_app/modbus_layer.py  -> Modbus acquisition
  Layer 2: dashboard_app/normalize.py     -> normalized snapshot
  Layer 3: dashboard_app/api.py           -> Flask HTTP API
  Layer 4: templates/ + static/           -> GUI
"""

from .api import create_app

__all__ = ["create_app"]

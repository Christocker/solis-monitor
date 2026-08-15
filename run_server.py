"""
solis-monitor SERVER launcher (for the dedicated server laptop).

Binds to 0.0.0.0 so the dashboard is reachable from any device on the
LAN, not just this machine.

Run:  python run_server.py
Then open on ANY device: http://<this-laptop-IP>:8080
"""

from dashboard_app.config import SERVER_PORT
from dashboard_app import create_app

SERVER_HOST = "0.0.0.0"

app = create_app()

if __name__ == "__main__":
    print("=" * 56)
    print(" SOLIS S6-EH1P6K-L-PLUS DASHBOARD (SERVER)")
    print("=" * 56)
    print(f" Bind:       {SERVER_HOST} (all network interfaces)")
    print(f" Dashboard:  http://<this-laptop-IP>:{SERVER_PORT}")
    print(f" Modbus:     Modbus TCP to the S2-WL-ST (read-only)")
    print(" Press Ctrl+C to stop.")
    print()
    app.run(host=SERVER_HOST, port=SERVER_PORT, debug=False, use_reloader=False)

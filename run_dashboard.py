"""
solis-monitor dashboard launcher.

Run:  python run_dashboard.py
Then open: http://127.0.0.1:8080
"""

from dashboard_app.config import SERVER_PORT
from dashboard_app import create_app

app = create_app()

if __name__ == "__main__":
    print("=" * 56)
    print(" SOLIS S6-EH1P6K-L-PLUS DASHBOARD")
    print("=" * 56)
    print(f" Dashboard:  http://127.0.0.1:{SERVER_PORT} (this machine only)")
    print(f" Modbus:     Modbus TCP to the S2-WL-ST (read-only)")
    print(" Press Ctrl+C to stop.")
    print()
    # Localhost only; use run_server.py to expose the dashboard on the LAN.
    app.run(host="127.0.0.1", port=SERVER_PORT, debug=False, use_reloader=False)

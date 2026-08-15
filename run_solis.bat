@echo off
cd /d "%~dp0"
python solis_diagnostic.py
echo.
echo Press any key to close...
pause >nul

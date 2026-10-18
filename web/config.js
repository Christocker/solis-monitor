/* ============================================================
   Web config — Supabase connection for the hosted website.
   Edit these two values before deploying to Vercel.
   ============================================================ */

// Your Supabase project URL (Dashboard > Project Settings > API).
// Example: "https://abcdefghijklmnop.supabase.co"
const SUPABASE_URL = "https://mjdpcruukzcxeiilmrrw.supabase.co";

// The anon / public key. Safe to expose to the browser because RLS
// only allows SELECT (read). Never use the service_role key here.
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qZHBjcnV1a3pjeGVpaWxtcnJ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY4MjIwMzIsImV4cCI6MjEwMjM5ODAzMn0.ssKbMKzgSpZZZsqDbauQnaPENdHtRp2jGzIwAjxqn20";

/* ---------------- Battery runtime estimate ----------------
   The hosted site cannot measure the pack, so give it the capacity here.
   Three Dyness 5.12 kWh low-voltage packs = 15.36 kWh nominal (the laptop's
   local dashboard auto-measures ~15.57 kWh from the recorded history; this
   value is only a fallback if system_info.battery_capacity_kwh is absent). */
const BATTERY_CAPACITY_KWH = 15.36;
const BATTERY_RESERVE_SOC = 10;      // runtime is counted down to this SOC (%)
const INVERTER_EFFICIENCY = 0.93;    // AC load -> battery draw

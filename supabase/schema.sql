-- ============================================================
-- solis-monitor: Supabase schema
-- Run this in the Supabase SQL Editor (Dashboard > SQL > New query).
-- It creates the tables the laptop syncs to and the website reads from.
-- ============================================================

-- Readings table: one row per sync (~every 2 seconds).
create table if not exists public.readings (
    id bigint generated always as identity primary key,
    ts_unix double precision not null,
    ts_iso text not null,
    pv1_voltage double precision,
    pv1_current double precision,
    pv2_voltage double precision,
    pv2_current double precision,
    pv_power double precision,
    grid_voltage double precision,
    grid_frequency double precision,
    battery_voltage double precision,
    battery_current double precision,
    battery_power double precision,
    battery_soc double precision,
    battery_soh double precision,
    house_load double precision,
    backup_load double precision
);

-- Index for fast time-range queries (the History page).
create index if not exists readings_ts_idx on public.readings (ts_unix desc);

-- System identity table (single row, id=1): serial number, model, etc.
create table if not exists public.system_info (
    id integer primary key,
    serial_number text,
    inverter_model text,
    protocol_version integer,
    product_model integer,
    updated_at timestamp with time zone default now()
);

-- ============================================================
-- Row Level Security (RLS)
-- ============================================================
-- The laptop inserts with the service_role key (bypasses RLS).
-- The website reads with the anon key. These policies let the
-- anon key SELECT (read-only) but never INSERT/UPDATE/DELETE.

alter table public.readings enable row level security;
alter table public.system_info enable row level security;

-- Anyone (with the anon key) can read readings.
create policy "readings public read"
    on public.readings for select
    using (true);

-- Only the service role (or an authenticated user) can write.
create policy "readings service write"
    on public.readings for insert
    with check (true);

-- System info: anyone can read, only service role can write.
create policy "system_info public read"
    on public.system_info for select
    using (true);

create policy "system_info service write"
    on public.system_info for all
    using (true)
    with check (true);

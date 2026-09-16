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
drop policy if exists "readings public read" on public.readings;
create policy "readings public read"
    on public.readings for select
    using (true);

-- Only the service role (or an authenticated user) can write.
drop policy if exists "readings service write" on public.readings;
create policy "readings service write"
    on public.readings for insert
    with check (true);

-- System info: anyone can read, only service role can write.
drop policy if exists "system_info public read" on public.system_info;
create policy "system_info public read"
    on public.system_info for select
    using (true);

drop policy if exists "system_info service write" on public.system_info;
create policy "system_info service write"
    on public.system_info for all
    using (true)
    with check (true);

-- ============================================================
-- Table grants
-- ============================================================
-- PostgREST requires the role to have table privileges in addition
-- to RLS policies. The website uses the anon key for SELECT only.
-- The laptop sync uses the service_role key, which bypasses RLS
-- but still needs explicit table grants to insert/update rows.

grant usage on schema public to anon;
grant select on public.readings to anon;
grant select on public.system_info to anon;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.readings to service_role;
grant select, insert, update, delete on public.system_info to service_role;

-- ============================================================
-- History bucketing function (full-history charts)
-- ============================================================
-- The raw table holds ~1.2M rows/month (one row every ~2s) and the
-- PostgREST API returns at most 1000 rows per request, so the History
-- page cannot page through the whole period. This function aggregates
-- the raw rows into a small, fixed number of time buckets in a single
-- request, while the raw data is kept in full.
--
-- Call with only p_buckets to bucket the entire dataset (earliest
-- record -> latest), or pass p_start/p_end for a specific range.
--
-- Example (Supabase REST):
--   POST /rest/v1/rpc/history_buckets   { "p_buckets": 480 }
--   POST /rest/v1/rpc/history_buckets   { "p_start": 0, "p_end": 1e12, "p_buckets": 168 }

create or replace function public.history_buckets(
    p_start double precision default null,
    p_end double precision default null,
    p_buckets integer default 240
)
returns table (
    bucket_ts double precision,
    samples bigint,
    grid_seconds double precision,
    pv_power double precision,
    pv1_voltage double precision,
    pv1_current double precision,
    pv2_voltage double precision,
    pv2_current double precision,
    grid_voltage double precision,
    grid_frequency double precision,
    battery_voltage double precision,
    battery_current double precision,
    battery_power double precision,
    battery_soc double precision,
    battery_soh double precision,
    house_load double precision,
    backup_load double precision,
    pv_power_max double precision
)
language sql
stable
as $$
    with bounds as (
        select
            coalesce(p_start, (select min(ts_unix) from public.readings)) as s,
            coalesce(p_end,   (select max(ts_unix) from public.readings)) as e,
            greatest(coalesce(p_buckets, 240), 1)::double precision as n
    ),
    b as (
        select
            floor((r.ts_unix - bounds.s)
                  / ((bounds.e - bounds.s) / bounds.n)) as bucket,
            ((bounds.e - bounds.s) / bounds.n) as width,
            r.ts_unix,
            r.pv_power, r.pv1_voltage, r.pv1_current,
            r.pv2_voltage, r.pv2_current,
            r.grid_voltage, r.grid_frequency,
            r.battery_voltage, r.battery_current, r.battery_power,
            r.battery_soc, r.battery_soh,
            r.house_load, r.backup_load
        from public.readings r, bounds
        where bounds.e > bounds.s
          and r.ts_unix >= bounds.s
          and r.ts_unix <= bounds.e
    )
    select
        min(b.ts_unix)                                    as bucket_ts,
        count(*)::bigint                                  as samples,
        avg(case when b.grid_voltage >= 50
                 then 1.0::double precision else 0.0::double precision end)
            * min(b.width)                                as grid_seconds,
        avg(b.pv_power)                                   as pv_power,
        avg(b.pv1_voltage)                                as pv1_voltage,
        avg(b.pv1_current)                                as pv1_current,
        avg(b.pv2_voltage)                                as pv2_voltage,
        avg(b.pv2_current)                                as pv2_current,
        avg(b.grid_voltage)                               as grid_voltage,
        avg(b.grid_frequency)                             as grid_frequency,
        avg(b.battery_voltage)                            as battery_voltage,
        avg(b.battery_current)                            as battery_current,
        avg(b.battery_power)                              as battery_power,
        avg(b.battery_soc)                                as battery_soc,
        avg(b.battery_soh)                                as battery_soh,
        avg(b.house_load)                                 as house_load,
        avg(b.backup_load)                                as backup_load,
        max(b.pv_power)                                   as pv_power_max
    from b
    group by b.bucket
    order by b.bucket;
$$;

grant execute on function
    public.history_buckets(double precision, double precision, integer)
    to anon, authenticated, service_role;

-- A full-month aggregation scans ~1.2M rows, which can exceed the default
-- 3s API statement timeout. Give this function a longer budget (it only
-- runs on demand when a large History range is opened) and allow parallel
-- aggregation workers.
alter function public.history_buckets(double precision, double precision, integer)
    set statement_timeout = '25s';
alter function public.history_buckets(double precision, double precision, integer)
    set max_parallel_workers_per_gather = 4;

-- Reload the PostgREST schema cache so the new function is callable
-- immediately from the website.
notify pgrst, 'reload schema';


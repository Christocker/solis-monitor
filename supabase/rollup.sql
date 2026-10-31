-- ============================================================
-- Fast History: 1-minute rollup table
-- ============================================================
-- Run this file once in the Supabase SQL editor (paste the whole file).
-- It is additive: existing tables/data are untouched.
--
-- Why: `history_buckets()` aggregates the raw `readings` table. A month of
-- 2-second samples is ~1.3M rows, which takes several seconds per call and
-- forces the website to split wide windows into many sequential chunks.
-- `readings_1m` keeps the same information pre-aggregated per minute, so a
-- full-archive query scans ~100k narrow rows instead of millions of wide ones.
--
-- Maintenance: an AFTER INSERT/UPDATE/DELETE trigger rebuilds the affected
-- minute on every new reading (a ~30-row aggregate), so the rollup stays in
-- lock-step with the live data. The website uses `history_buckets_fast()`,
-- which automatically falls back to `history_buckets()` for narrow windows
-- or while the rollup is still being backfilled.

-- The one-time backfill scans the whole raw table; give it room to finish.
set statement_timeout = '600s';

-- ------------------------------------------------------------
-- 1. Rollup table
-- ------------------------------------------------------------
create table if not exists public.readings_1m (
    bucket_ts    double precision primary key,   -- minute start (unix seconds)
    samples      bigint not null,
    ts_first     double precision,
    ts_last      double precision,
    grid_seconds double precision,               -- grid-connected seconds
    pv_power_max double precision,

    pv1_voltage_sum double precision, pv1_voltage_n bigint,
    pv1_current_sum double precision, pv1_current_n bigint,
    pv2_voltage_sum double precision, pv2_voltage_n bigint,
    pv2_current_sum double precision, pv2_current_n bigint,
    pv_power_sum    double precision, pv_power_n    bigint,
    grid_voltage_sum double precision, grid_voltage_n bigint,
    grid_frequency_sum double precision, grid_frequency_n bigint,
    battery_voltage_sum double precision, battery_voltage_n bigint,
    battery_current_sum double precision, battery_current_n bigint,
    battery_power_sum   double precision, battery_power_n   bigint,
    battery_soc_sum     double precision, battery_soc_n     bigint,
    battery_soh_sum     double precision, battery_soh_n     bigint,
    house_load_sum      double precision, house_load_n      bigint,
    backup_load_sum     double precision, backup_load_n     bigint
);

alter table public.readings_1m enable row level security;

drop policy if exists "readings_1m public read" on public.readings_1m;
create policy "readings_1m public read"
    on public.readings_1m for select using (true);

-- The trigger writes through a SECURITY DEFINER function (owner = postgres),
-- so this policy is only a belt-and-braces fallback for direct service writes.
drop policy if exists "readings_1m service write" on public.readings_1m;
create policy "readings_1m service write"
    on public.readings_1m for all
    to service_role
    using (true) with check (true);

grant select on public.readings_1m to anon, authenticated;
grant select, insert, update, delete on public.readings_1m to service_role;

-- ------------------------------------------------------------
-- 2. Rebuild one range of the rollup (also used by the trigger)
-- ------------------------------------------------------------
create or replace function public.readings_rollup_refresh(
    p_from double precision,
    p_to double precision
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    delete from public.readings_1m
     where bucket_ts >= floor(p_from / 60) * 60
       and bucket_ts < p_to;

    insert into public.readings_1m (
        bucket_ts, samples, ts_first, ts_last, grid_seconds, pv_power_max,
        pv1_voltage_sum, pv1_voltage_n, pv1_current_sum, pv1_current_n,
        pv2_voltage_sum, pv2_voltage_n, pv2_current_sum, pv2_current_n,
        pv_power_sum, pv_power_n, grid_voltage_sum, grid_voltage_n,
        grid_frequency_sum, grid_frequency_n,
        battery_voltage_sum, battery_voltage_n,
        battery_current_sum, battery_current_n,
        battery_power_sum, battery_power_n,
        battery_soc_sum, battery_soc_n, battery_soh_sum, battery_soh_n,
        house_load_sum, house_load_n, backup_load_sum, backup_load_n
    )
    select
        floor(ts_unix / 60) * 60,
        count(*),
        min(ts_unix),
        max(ts_unix),
        case when count(*) > 1 then
            sum(case when grid_voltage >= 50 then 1 else 0 end)::double precision
            * (max(ts_unix) - min(ts_unix)) / (count(*) - 1)
        else 0 end,
        max(pv_power),
        sum(pv1_voltage), count(pv1_voltage),
        sum(pv1_current), count(pv1_current),
        sum(pv2_voltage), count(pv2_voltage),
        sum(pv2_current), count(pv2_current),
        sum(pv_power),    count(pv_power),
        sum(grid_voltage), count(grid_voltage),
        sum(grid_frequency), count(grid_frequency),
        sum(battery_voltage), count(battery_voltage),
        sum(battery_current), count(battery_current),
        sum(battery_power),   count(battery_power),
        sum(battery_soc),     count(battery_soc),
        sum(battery_soh),     count(battery_soh),
        sum(house_load),      count(house_load),
        sum(backup_load),     count(backup_load)
    from public.readings
    where ts_unix >= p_from and ts_unix < p_to
    group by floor(ts_unix / 60) * 60;
end;
$$;

-- The refresh helper is internal: only the trigger (definer) and the owner
-- need it. Do not expose a generic "rebuild any range" endpoint to clients.
revoke all on function public.readings_rollup_refresh(double precision, double precision)
    from public;
grant execute on function public.readings_rollup_refresh(double precision, double precision)
    to service_role;

-- ------------------------------------------------------------
-- 3. Backfill existing history (day-sized chunks so no single
--    statement runs long). Safe to re-run; it just rebuilds.
-- ------------------------------------------------------------
do $$
declare
    d double precision;
    hi double precision;
begin
    select min(ts_unix), max(ts_unix) + 1 into d, hi from public.readings;
    while d is not null and d < hi loop
        perform public.readings_rollup_refresh(d, least(d + 86400, hi));
        d := d + 86400;
    end loop;
end $$;

-- ------------------------------------------------------------
-- 4. Keep it current: one aggregate per inserted reading
-- ------------------------------------------------------------
create or replace function public.readings_rollup_touch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    m double precision;
begin
    m := floor(coalesce(new.ts_unix, old.ts_unix) / 60) * 60;
    perform public.readings_rollup_refresh(m, m + 60);
    return null;
end;
$$;

drop trigger if exists readings_rollup_touch on public.readings;
create trigger readings_rollup_touch
    after insert or update or delete on public.readings
    for each row execute function public.readings_rollup_touch();

-- ------------------------------------------------------------
-- 5. Fast bucket query (same shape as history_buckets)
-- ------------------------------------------------------------
create or replace function public.history_buckets_fast(
    p_start double precision default null,
    p_end double precision default null,
    p_buckets integer default 240
)
returns table (
    bucket_ts double precision,
    samples bigint,
    grid_seconds double precision,
    bucket_width double precision,
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
language plpgsql
stable
as $$
declare
    n integer := greatest(coalesce(p_buckets, 240), 1);
    s double precision;
    e double precision;
    w double precision;
    r_first double precision;
    r_last double precision;
begin
    select coalesce(p_start, (select min(ts_unix) from public.readings)),
           coalesce(p_end,   (select max(ts_unix) from public.readings))
      into s, e;

    if s is null or e is null or e <= s then
        return;
    end if;

    w := (e - s) / n;

    -- Narrow buckets stay raw so the chart is exact (the rollup is minute
    -- granular and a row cannot be split across two buckets).
    if w < 900 then
        return query
            select * from public.history_buckets(p_start, p_end, p_buckets);
        return;
    end if;

    -- Rollup not built/caught up yet? Fall back to the raw aggregation.
    -- (Qualify with a table alias: `bucket_ts` is also an output column name
    -- here, and PL/pgSQL would otherwise substitute the variable.)
    select (select m.bucket_ts from public.readings_1m m
             order by m.bucket_ts asc limit 1),
           (select m.bucket_ts from public.readings_1m m
             order by m.bucket_ts desc limit 1)
      into r_first, r_last;
    if r_first is null or r_first > s + 60 or r_last < e - 240 then
        return query
            select * from public.history_buckets(p_start, p_end, p_buckets);
        return;
    end if;

    return query
    select
        min(r.ts_first)::double precision                    as bucket_ts,
        sum(r.samples)::bigint                               as samples,
        sum(r.grid_seconds)::double precision                as grid_seconds,
        w                                                    as bucket_width,
        (sum(r.pv_power_sum) / nullif(sum(r.pv_power_n), 0)::double precision)::double precision,
        (sum(r.pv1_voltage_sum) / nullif(sum(r.pv1_voltage_n), 0)::double precision)::double precision,
        (sum(r.pv1_current_sum) / nullif(sum(r.pv1_current_n), 0)::double precision)::double precision,
        (sum(r.pv2_voltage_sum) / nullif(sum(r.pv2_voltage_n), 0)::double precision)::double precision,
        (sum(r.pv2_current_sum) / nullif(sum(r.pv2_current_n), 0)::double precision)::double precision,
        (sum(r.grid_voltage_sum) / nullif(sum(r.grid_voltage_n), 0)::double precision)::double precision,
        (sum(r.grid_frequency_sum) / nullif(sum(r.grid_frequency_n), 0)::double precision)::double precision,
        (sum(r.battery_voltage_sum) / nullif(sum(r.battery_voltage_n), 0)::double precision)::double precision,
        (sum(r.battery_current_sum) / nullif(sum(r.battery_current_n), 0)::double precision)::double precision,
        (sum(r.battery_power_sum) / nullif(sum(r.battery_power_n), 0)::double precision)::double precision,
        (sum(r.battery_soc_sum) / nullif(sum(r.battery_soc_n), 0)::double precision)::double precision,
        (sum(r.battery_soh_sum) / nullif(sum(r.battery_soh_n), 0)::double precision)::double precision,
        (sum(r.house_load_sum) / nullif(sum(r.house_load_n), 0)::double precision)::double precision,
        (sum(r.backup_load_sum) / nullif(sum(r.backup_load_n), 0)::double precision)::double precision,
        max(r.pv_power_max)::double precision
    from public.readings_1m r
    where r.bucket_ts >= floor(s / 60) * 60
      and r.bucket_ts <= floor(e / 60) * 60
    group by least(floor((r.bucket_ts + 30 - s) / w), n - 1);
end;
$$;

-- A whole-archive rollup scan is far cheaper than the raw aggregation, but
-- keep a generous budget in case the rollup is still cold.
alter function public.history_buckets_fast(double precision, double precision, integer)
    set statement_timeout = '25s';

grant execute on function public.history_buckets_fast(double precision, double precision, integer)
    to anon, authenticated, service_role;

-- Hint PostgREST to pick up the new functions right away.
notify pgrst, 'reload schema';

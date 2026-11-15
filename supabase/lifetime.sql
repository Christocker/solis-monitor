-- ============================================================
-- Exact lifetime totals published by the laptop
-- ============================================================
-- Run this AFTER supabase/auth_lockdown.sql (it uses public.is_app_user()).
-- The laptop upserts one row every 5 minutes from its local SQLite archive;
-- the hosted site displays it instead of estimating from cloud buckets.
-- Safe to run more than once.
-- ============================================================

create table if not exists public.lifetime_stats (
    id                     integer primary key default 1 check (id = 1),
    solar_kwh              double precision,
    consumption_kwh        double precision,
    battery_charge_kwh     double precision,
    battery_discharge_kwh  double precision,
    grid_import_kwh        double precision,
    grid_export_kwh        double precision,
    first_record           double precision,
    samples                bigint,
    updated_at             timestamptz not null default now()
);

insert into public.lifetime_stats (id) values (1) on conflict (id) do nothing;

alter table public.lifetime_stats enable row level security;

drop policy if exists lifetime_stats_read on public.lifetime_stats;
create policy lifetime_stats_read on public.lifetime_stats
    for select to authenticated
    using ((select public.is_app_user()));

revoke all on public.lifetime_stats from anon, authenticated;
grant select on public.lifetime_stats to authenticated;
grant all on public.lifetime_stats to service_role;

notify pgrst, 'reload schema';

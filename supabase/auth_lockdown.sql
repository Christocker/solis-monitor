-- ============================================================
-- Private hosted site: allow only selected Auth users
-- ============================================================
-- Run this AFTER schema.sql, rollup.sql and relay.sql.
-- It is idempotent. It does NOT change the local dashboard; the laptop
-- keeps using service_role for polling, cloud sync and relay control.
--
-- What it does:
--   * creates public.app_users (the allowlist);
--   * adds the shared viewer account to it;
--   * makes every table/RPC/relay operation require an allowed Auth user;
--   * removes all anon access.
--
-- The shared account is created separately (Supabase Auth admin API):
--   email:    viewer@solis-monitor.local
--   password: the 6-digit PIN (not stored in this repo)
--
-- To add another person later:
--   insert into public.app_users (user_id, email)
--   select id, email from auth.users where email = 'their@email';
-- ============================================================

-- ------------------------------------------------------------
-- 1. Allowlist
-- ------------------------------------------------------------
create table if not exists public.app_users (
    user_id    uuid primary key references auth.users(id) on delete cascade,
    email      text,
    created_at timestamptz not null default now()
);

alter table public.app_users enable row level security;
revoke all on public.app_users from anon, authenticated;
grant all on public.app_users to service_role;

insert into public.app_users (user_id, email)
select id, email from auth.users
where email = 'viewer@solis-monitor.local'
on conflict (user_id) do nothing;

-- Security definer so the policy can read the allowlist without exposing it
-- to the client. auth.uid() still comes from the caller's JWT.
create or replace function public.is_app_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1 from public.app_users where user_id = auth.uid()
    );
$$;

revoke all on function public.is_app_user() from public;
grant execute on function public.is_app_user() to authenticated, service_role;

-- ------------------------------------------------------------
-- 2. Read policies: authenticated + allowlisted only
-- ------------------------------------------------------------
drop policy if exists "readings public read" on public.readings;
drop policy if exists "readings authenticated read" on public.readings;
create policy "readings authenticated read" on public.readings
    for select to authenticated using ((select public.is_app_user()));

drop policy if exists "system_info public read" on public.system_info;
drop policy if exists "system_info authenticated read" on public.system_info;
create policy "system_info authenticated read" on public.system_info
    for select to authenticated using ((select public.is_app_user()));

drop policy if exists "sync_status public read" on public.sync_status;
drop policy if exists "sync_status authenticated read" on public.sync_status;
create policy "sync_status authenticated read" on public.sync_status
    for select to authenticated using ((select public.is_app_user()));

drop policy if exists "daily_energy public read" on public.daily_energy;
drop policy if exists "daily_energy authenticated read" on public.daily_energy;
create policy "daily_energy authenticated read" on public.daily_energy
    for select to authenticated using ((select public.is_app_user()));

drop policy if exists "readings_1m public read" on public.readings_1m;
drop policy if exists "readings_1m authenticated read" on public.readings_1m;
create policy "readings_1m authenticated read" on public.readings_1m
    for select to authenticated using ((select public.is_app_user()));

drop policy if exists relay_status_read on public.relay_status;
drop policy if exists relay_status_authenticated_read on public.relay_status;
create policy relay_status_authenticated_read on public.relay_status
    for select to authenticated using ((select public.is_app_user()));

-- ------------------------------------------------------------
-- 3. Measurement tables: writes are service_role only
-- ------------------------------------------------------------
drop policy if exists "readings service write" on public.readings;
create policy "readings service write" on public.readings
    for insert to service_role with check (true);

drop policy if exists "system_info service write" on public.system_info;
create policy "system_info service write" on public.system_info
    for all to service_role using (true) with check (true);

drop policy if exists "sync_status service write" on public.sync_status;
create policy "sync_status service write" on public.sync_status
    for all to service_role using (true) with check (true);

drop policy if exists "daily_energy service write" on public.daily_energy;
create policy "daily_energy service write" on public.daily_energy
    for all to service_role using (true) with check (true);

drop policy if exists "readings_1m service write" on public.readings_1m;
create policy "readings_1m service write" on public.readings_1m
    for all to service_role using (true) with check (true);

-- ------------------------------------------------------------
-- 4. Relay policies: signed-in allowlisted users only
-- ------------------------------------------------------------
drop policy if exists relay_control_read on public.relay_control;
drop policy if exists relay_control_authenticated_read on public.relay_control;
create policy relay_control_authenticated_read on public.relay_control
    for select to authenticated using ((select public.is_app_user()));

drop policy if exists relay_control_write on public.relay_control;
drop policy if exists relay_control_authenticated_write on public.relay_control;
create policy relay_control_authenticated_write on public.relay_control
    for update to authenticated
    using ((select public.is_app_user()))
    with check ((select public.is_app_user()));

drop policy if exists relay_config_read on public.relay_config;
drop policy if exists relay_config_authenticated_read on public.relay_config;
create policy relay_config_authenticated_read on public.relay_config
    for select to authenticated using ((select public.is_app_user()));

drop policy if exists relay_config_write on public.relay_config;
drop policy if exists relay_config_authenticated_write on public.relay_config;
create policy relay_config_authenticated_write on public.relay_config
    for update to authenticated
    using ((select public.is_app_user()))
    with check ((select public.is_app_user()));

-- ------------------------------------------------------------
-- 5. Table grants: anon gets nothing
-- ------------------------------------------------------------
revoke all on public.readings from anon, authenticated;
grant select on public.readings to authenticated;
grant select, insert, update, delete on public.readings to service_role;

revoke all on public.system_info from anon, authenticated;
grant select on public.system_info to authenticated;
grant select, insert, update, delete on public.system_info to service_role;

revoke all on public.sync_status from anon, authenticated;
grant select on public.sync_status to authenticated;
grant select, insert, update, delete on public.sync_status to service_role;

revoke all on public.daily_energy from anon, authenticated;
grant select on public.daily_energy to authenticated;
grant select, insert, update, delete on public.daily_energy to service_role;

revoke all on public.readings_1m from anon, authenticated;
grant select on public.readings_1m to authenticated;
grant select, insert, update, delete on public.readings_1m to service_role;

revoke all on public.relay_status from anon, authenticated;
grant select on public.relay_status to authenticated;
grant all on public.relay_status to service_role;

revoke all on public.relay_control from anon, authenticated;
grant select, update on public.relay_control to authenticated;
grant all on public.relay_control to service_role;

revoke all on public.relay_config from anon, authenticated;
-- relay.sql used column-level grants, which REVOKE ALL ON TABLE does not
-- remove; revoke them explicitly.
revoke update (on_soc, off_soc, enabled, requested_by)
    on public.relay_config from anon, authenticated;
grant select on public.relay_config to authenticated;
grant update (on_soc, off_soc, enabled, requested_by)
    on public.relay_config to authenticated;
grant all on public.relay_config to service_role;

-- ------------------------------------------------------------
-- 6. History RPCs: authenticated + allowlisted only
-- ------------------------------------------------------------
-- Functions get EXECUTE for PUBLIC by default, so revoke PUBLIC too, not
-- just the explicit anon grant from schema.sql/rollup.sql.
revoke execute on function public.history_buckets(
    double precision, double precision, integer) from public;
revoke execute on function public.history_buckets(
    double precision, double precision, integer) from anon;
grant execute on function public.history_buckets(
    double precision, double precision, integer) to authenticated, service_role;

revoke execute on function public.history_buckets_fast(
    double precision, double precision, integer) from public;
revoke execute on function public.history_buckets_fast(
    double precision, double precision, integer) from anon;
grant execute on function public.history_buckets_fast(
    double precision, double precision, integer) to authenticated, service_role;

grant usage on schema public to authenticated;

notify pgrst, 'reload schema';

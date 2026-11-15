-- ============================================================
-- Public relay control queue
-- ============================================================
-- The hosted site is static: it cannot reach the inverter or Home Assistant.
-- So it writes an *intent* here, and the local Solis Monitor (which owns the
-- HA token and the LAN) applies it to the relay and publishes the result.
--
--   website  --PATCH--> relay_control  --polled by--> local monitor --> HA
--   website  <--SELECT-- relay_status  <--written by-- local monitor
--
-- Security:
--   * relay_status is public read (it only mirrors what the dashboard shows).
--   * relay_control is public write: the site's button has no login, so the
--     anon key shipped in the page can queue ON/OFF. Anyone who finds the
--     site can therefore toggle the charger -- accepted trade-off.
--   * The 3 s throttle trigger below limits command spam.
--   * The local monitor uses the service_role key, which bypasses RLS.
--
-- Safe to run more than once.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Tables
-- ------------------------------------------------------------
create table if not exists public.relay_control (
    id            integer primary key default 1 check (id = 1),
    desired_state text check (desired_state in ('on', 'off')),
    requested_at  timestamptz,
    requested_by  text,
    applied_at    timestamptz
);

create table if not exists public.relay_status (
    id          integer primary key default 1 check (id = 1),
    state       text,
    reachable   boolean,
    auto        boolean,
    soc         double precision,
    on_soc      double precision,
    off_soc     double precision,
    last_action jsonb,
    updated_at  timestamptz
);

-- Rule settings are a separate command row: the website writes thresholds and
-- the enable switch here; the local monitor applies them and publishes the
-- resulting live values in relay_status.
create table if not exists public.relay_config (
    id            integer primary key default 1 check (id = 1),
    on_soc        double precision not null default 8,
    off_soc       double precision not null default 10,
    enabled       boolean not null default true,
    requested_at  timestamptz,
    applied_at    timestamptz,
    requested_by  text,
    constraint relay_config_rule_valid check (
        on_soc >= 0 and on_soc <= 100
        and off_soc > on_soc and off_soc <= 100
    )
);

insert into public.relay_control (id) values (1) on conflict (id) do nothing;
insert into public.relay_status  (id) values (1) on conflict (id) do nothing;
insert into public.relay_config  (id) values (1) on conflict (id) do nothing;

-- ------------------------------------------------------------
-- 2. Row level security
-- ------------------------------------------------------------
alter table public.relay_control enable row level security;
alter table public.relay_status  enable row level security;
alter table public.relay_config  enable row level security;

-- Public can read the relay state (same information as the dashboard).
drop policy if exists relay_status_read on public.relay_status;
create policy relay_status_read on public.relay_status
    for select to anon, authenticated using (true);

grant select on public.relay_status to anon, authenticated;

-- Public read/write: the website button has no login. See the header note.
drop policy if exists relay_control_read on public.relay_control;
create policy relay_control_read on public.relay_control
    for select to anon, authenticated using (true);

drop policy if exists relay_control_write on public.relay_control;
create policy relay_control_write on public.relay_control
    for update to anon, authenticated using (true) with check (true);

grant select, update on public.relay_control to anon, authenticated;

-- PostgREST roles need explicit table privileges; RLS only filters rows.
-- The local monitor writes with the service_role key (it bypasses RLS, but
-- still needs GRANT), otherwise every poll fails with 403.
grant all on public.relay_control to service_role;
grant all on public.relay_status  to service_role;

-- Rule settings: public read/write for the two thresholds and the enable
-- switch. Column-level grants keep requested_at/applied_at monitor-only.
drop policy if exists relay_config_read on public.relay_config;
create policy relay_config_read on public.relay_config
    for select to anon, authenticated using (true);

drop policy if exists relay_config_write on public.relay_config;
create policy relay_config_write on public.relay_config
    for update to anon, authenticated using (true) with check (true);

grant select on public.relay_config to anon, authenticated;
revoke update on public.relay_config from anon, authenticated;
grant update (on_soc, off_soc, enabled, requested_by)
    on public.relay_config to anon, authenticated;
grant all on public.relay_config to service_role;

-- Timestamp the request server-side so a client cannot fake "newer" settings.
-- Only settings-column updates touch requested_at; the monitor's applied_at
-- patch does not, so applying a command cannot re-queue it.
create or replace function public.relay_config_touch()
returns trigger
language plpgsql
as $$
begin
    new.requested_at := now();
    return new;
end;
$$;

drop trigger if exists relay_config_touch on public.relay_config;
create trigger relay_config_touch
    before update of on_soc, off_soc, enabled on public.relay_config
    for each row execute function public.relay_config_touch();

-- ------------------------------------------------------------
-- 3. Throttle: at most one accepted command per 3 seconds
-- ------------------------------------------------------------
create or replace function public.relay_control_throttle()
returns trigger
language plpgsql
as $$
begin
    if old.requested_at is not null
       and new.requested_at is not null
       and new.requested_at > old.requested_at
       and new.requested_at - old.requested_at < interval '3 seconds' then
        raise exception 'relay command throttled' using errcode = 'P0001';
    end if;
    return new;
end;
$$;

drop trigger if exists relay_control_throttle on public.relay_control;
create trigger relay_control_throttle
    before update on public.relay_control
    for each row execute function public.relay_control_throttle();

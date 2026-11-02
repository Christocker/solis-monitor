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
--   * relay_control requires a signed-in Supabase Auth user; anonymous
--     clients cannot read or write it.
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

insert into public.relay_control (id) values (1) on conflict (id) do nothing;
insert into public.relay_status  (id) values (1) on conflict (id) do nothing;

-- ------------------------------------------------------------
-- 2. Row level security
-- ------------------------------------------------------------
alter table public.relay_control enable row level security;
alter table public.relay_status  enable row level security;

-- Public can read the relay state (same information as the dashboard).
drop policy if exists relay_status_read on public.relay_status;
create policy relay_status_read on public.relay_status
    for select to anon, authenticated using (true);

grant select on public.relay_status to anon, authenticated;

-- Only a signed-in user can see and change the command row.
drop policy if exists relay_control_read on public.relay_control;
create policy relay_control_read on public.relay_control
    for select to authenticated using (true);

drop policy if exists relay_control_write on public.relay_control;
create policy relay_control_write on public.relay_control
    for update to authenticated using (true) with check (true);

grant select, update on public.relay_control to authenticated;

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

-- kiosk-health.sql — per-tablet heartbeat table for stuck-punch notifications (Part 1).
--
-- Each kiosk upserts one row per device_id (site, stuck_count, queue_length). A trigger stamps
-- last_seen/updated_at = now() SERVER-SIDE on every write, so a skewed tablet clock can never affect
-- the dashboard's "went silent" detection. Non-sensitive (no secrets) → anon may read + upsert, unlike
-- the credential/throttle tables in kiosk-admin-gate.sql. Additive + idempotent; owner runs once.
--
-- The RSR Admin dashboard (home.js) reads this and shows a two-tier banner: RED for stuck punches or a
-- yard that WAS reporting and went silent >30 min; GREY for a yard that never sent a heartbeat (tablet
-- still on the old build). See docs/superpowers/specs/2026-07-20-stuck-punch-notifications-design.md.

create table if not exists public.kiosk_health (
  device_id     text        primary key,       -- stable per-tablet id (kiosk localStorage rsr_device_id)
  site          text,                           -- active yard NAME reported by that tablet
  stuck_count   integer     not null default 0, -- dead-lettered punches on that tablet
  queue_length  integer     not null default 0, -- non-dead punches still waiting to sync
  last_seen     timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Server-authoritative timestamps: set last_seen/updated_at = now() on every insert AND update, so a
-- tablet's own (possibly skewed) clock never influences the "went silent" alarm.
create or replace function public.kiosk_health_touch()
returns trigger language plpgsql as $$
begin
  new.last_seen  := now();
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists trg_kiosk_health_touch on public.kiosk_health;
create trigger trg_kiosk_health_touch
  before insert or update on public.kiosk_health
  for each row execute function public.kiosk_health_touch();

-- The kiosk upserts and the dashboard reads with the public anon key; nothing secret lives here.
grant select, insert, update on public.kiosk_health to anon, authenticated;

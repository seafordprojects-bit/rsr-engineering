-- ═══════════════════════════════════════════════════════════════════════════════════════════
--  Stuck-punch alerts — Part 2: server-side Telegram watcher (pg_cron + pg_net)
--
--  All alert SENDING is server-side. The bot token lives ONLY in a REST-locked table (anon can't read
--  it). The kiosk writes kiosk_health.stuck_details (names + punch times) and pings kiosk_alert_tick().
--  Idempotent + additive. STEP 0 is read-only. See the Part-2 design spec for the full rationale.
--  Silence + stuck-reminder alerts run 6 AM -> the LIVE OT cut-off (settings.dismissal, e.g. 22:00), so
--  evening OT is covered; the daily digest stays ~9 AM. No cut-off time is hardcoded.
--
--  BEFORE RUNNING: in STEP 6, replace the two placeholders with your bot token + the "RSR Kiosk Alerts"
--  chat ID. AFTER: do NOT commit this file with the real token — put the placeholders back / discard.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ── STEP 0 — CENSUS (read-only; run first) ───────────────────────────────────────────────────
select extname from pg_extension where extname in ('pg_cron','pg_net');                 -- expect both after STEP 1
select to_regclass('public.kiosk_alert_config') as cfg,
       to_regclass('public.kiosk_alert_state')  as st,
       to_regclass('public.kiosk_alert_meta')   as meta;                                 -- expect nulls before
select column_name from information_schema.columns
 where table_schema='public' and table_name='kiosk_health' and column_name='stuck_details';  -- empty before
select jobname, schedule from cron.job where jobname = 'kiosk-alert-tick';               -- empty before (cron.job exists only if pg_cron on)

-- ── STEP 1 — extensions (if either errors: enable it in Supabase Dashboard ▸ Database ▸ Extensions, then re-run) ──
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── STEP 2 — data column + REST-locked config/state/meta tables ──────────────────────────────
alter table public.kiosk_health add column if not exists stuck_details jsonb;

-- Bot token + alert chat ID — REST-LOCKED (only the security-definer functions read it).
create table if not exists public.kiosk_alert_config (
  id            boolean     primary key default true check (id),
  tg_token      text,
  alert_chat_id text,
  updated_at    timestamptz not null default now()
);
insert into public.kiosk_alert_config (id) values (true) on conflict (id) do nothing;
revoke all on public.kiosk_alert_config from anon, authenticated;

-- Per-device alert bookkeeping — REST-locked (anon can't tamper with alert state).
create table if not exists public.kiosk_alert_state (
  device_id        text primary key,
  silence_state    text not null default 'ok',   -- 'ok' | 'silent'
  stuck_alerted_at timestamptz,                   -- last stuck alert/reminder sent; null = not alerting
  updated_at       timestamptz not null default now()
);
revoke all on public.kiosk_alert_state from anon, authenticated;

-- Daily-digest dedup — REST-locked singleton.
create table if not exists public.kiosk_alert_meta (
  id                boolean primary key default true check (id),
  last_summary_date date
);
insert into public.kiosk_alert_meta (id) values (true) on conflict (id) do nothing;
revoke all on public.kiosk_alert_meta from anon, authenticated;

-- ── STEP 3 — functions ───────────────────────────────────────────────────────────────────────
-- Send one Telegram message via pg_net, reading the token from the locked config. Internal only —
-- NOT granted to anon (it takes arbitrary text; exposing it would let anyone spam the group).
create or replace function public.kiosk_alert_send(p_msg text)
returns void language plpgsql volatile security definer set search_path = public as $$
declare v_token text; v_chat text;
begin
  select tg_token, alert_chat_id into v_token, v_chat from public.kiosk_alert_config where id;
  if coalesce(v_token,'') = '' or coalesce(v_chat,'') = '' then return; end if;
  begin
    perform net.http_post(
      url     := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
      body    := jsonb_build_object('chat_id', v_chat, 'text', p_msg, 'disable_web_page_preview', true),
      headers := jsonb_build_object('Content-Type','application/json'));
  exception when others then null;   -- a send failure never aborts the tick
  end;
end $$;
revoke all on function public.kiosk_alert_send(text) from public, anon, authenticated;

-- The watcher. Runs every 5 min (cron) and on the kiosk ping (RPC). Idempotent + state-guarded.
create or replace function public.kiosk_alert_tick()
returns void language plpgsql volatile security definer set search_path = public as $$
declare
  v_token    text;  v_chat   text;
  v_now      timestamptz := now();
  v_today    date := (now() at time zone 'Asia/Manila')::date;
  v_hr       int  := extract(hour from (now() at time zone 'Asia/Manila'));
  v_nowmin   int  := extract(hour from (now() at time zone 'Asia/Manila'))*60 + extract(minute from (now() at time zone 'Asia/Manila'));
  v_cutmin   int  := 22*60;   -- alert-window upper bound (minutes-of-day); default 22:00, overridden by live settings.dismissal
  v_dis      text;
  v_work     boolean;
  r          record;   d jsonb;   v_yard text;
  v_silent   boolean;  v_repd_today boolean;  v_mins int;
  v_state    text;     v_stuck_at timestamptz;   v_last_sum date;
  v_lines    text;     v_issues text := '';   v_missing text := '';   v_ntab int := 0;
begin
  select tg_token, alert_chat_id into v_token, v_chat from public.kiosk_alert_config where id;
  if coalesce(v_token,'') = '' or coalesce(v_chat,'') = '' then return; end if;   -- not configured
  -- Alert window runs 6 AM -> the live OT cut-off (settings.dismissal), so silence/stuck alerts cover
  -- evening OT while crews are still punching. Falls back to 22:00 if dismissal is unset/invalid. The
  -- ~9 AM daily digest (below) is unaffected. Nothing hardcodes a specific cut-off.
  begin
    select value into v_dis from public.settings where key = 'dismissal';
    v_dis := btrim(replace(coalesce(v_dis, ''), '"', ''));
    if v_dis ~ '^\d{1,2}:\d{2}$' then
      v_cutmin := split_part(v_dis, ':', 1)::int * 60 + split_part(v_dis, ':', 2)::int;
    end if;
  exception when others then null;
  end;
  v_work := (v_nowmin >= 6*60 and v_nowmin < v_cutmin);

  for r in select device_id, coalesce(nullif(btrim(site),''),'(unknown)') as site,
                  coalesce(stuck_count,0) as stuck_count, last_seen, stuck_details
             from public.kiosk_health loop
    v_ntab := v_ntab + 1;
    insert into public.kiosk_alert_state (device_id) values (r.device_id) on conflict (device_id) do nothing;
    select silence_state, stuck_alerted_at into v_state, v_stuck_at
      from public.kiosk_alert_state where device_id = r.device_id for update;

    v_silent     := r.last_seen < v_now - interval '30 minutes';
    v_repd_today := (r.last_seen at time zone 'Asia/Manila')::date = v_today;
    v_mins       := floor(extract(epoch from (v_now - r.last_seen)) / 60);

    -- SILENCE (only a tablet that reported earlier TODAY then stopped — tablets are off overnight).
    if v_work and v_silent and v_repd_today and v_state <> 'silent' then
      perform public.kiosk_alert_send('🔴 ' || r.site || ' tablet silent — last seen ' || v_mins || ' min ago'
              || case when r.stuck_count > 0 then ' · ' || r.stuck_count || ' stuck' else '' end);
      update public.kiosk_alert_state set silence_state='silent', updated_at=v_now where device_id=r.device_id;
    elsif not v_silent and v_state = 'silent' then
      perform public.kiosk_alert_send('✅ ' || r.site || ' tablet back online');
      update public.kiosk_alert_state set silence_state='ok', updated_at=v_now where device_id=r.device_id;
    end if;

    -- STUCK (immediate on first, then every 2h during work hours) — uses the kiosk-written details.
    if r.stuck_count > 0 then
      if v_stuck_at is null or (v_work and v_now - v_stuck_at >= interval '2 hours') then
        v_lines := '';
        if jsonb_typeof(r.stuck_details) = 'array' then
          for d in select value from jsonb_array_elements(r.stuck_details) loop
            v_lines := v_lines || E'\n• ' || coalesce(d->>'name', d->>'code', '?')
                       || ' (' || coalesce(d->>'date','') || '): ' || coalesce(d->>'times','');
          end loop;
        end if;
        perform public.kiosk_alert_send(
          (case when v_stuck_at is null then '⚠ Stuck punches — ' else '⏰ Still stuck — ' end)
          || r.site || ' (' || r.stuck_count || ')' || v_lines
          || E'\nFix + Retry in Admin ▸ Stuck punches.');
        update public.kiosk_alert_state set stuck_alerted_at=v_now, updated_at=v_now where device_id=r.device_id;
      end if;
    elsif v_stuck_at is not null then
      perform public.kiosk_alert_send('✅ ' || r.site || ' — all stuck punches resolved');
      update public.kiosk_alert_state set stuck_alerted_at=null, updated_at=v_now where device_id=r.device_id;
    end if;

    -- digest accounting
    if r.stuck_count > 0 then          v_issues := v_issues || E'\n• ' || r.site || ': ' || r.stuck_count || ' stuck';
    elsif not v_repd_today then         v_issues := v_issues || E'\n• ' || r.site || ': no report today';
    elsif v_silent then                 v_issues := v_issues || E'\n• ' || r.site || ': silent ' || v_mins || ' min';
    end if;
  end loop;

  -- yards in the central list with NO kiosk_health row at all (never rolled out) — info note
  begin
    for v_yard in select value from jsonb_array_elements_text(
                    (select value::jsonb from public.settings where key = 'attendance_sites')) loop
      if not exists (select 1 from public.kiosk_health
                     where lower(btrim(coalesce(site,''))) = lower(btrim(v_yard))) then
        v_missing := v_missing || ', ' || v_yard;
      end if;
    end loop;
  exception when others then null;   -- tolerate a missing/malformed attendance_sites setting
  end;

  -- DAILY DIGEST (~9 AM Manila, once/day, always send)
  select last_summary_date into v_last_sum from public.kiosk_alert_meta where id;
  if v_hr >= 9 and (v_last_sum is null or v_today > v_last_sum) then
    perform public.kiosk_alert_send(
      case when v_issues = '' then '✅ Daily check — all reporting tablets healthy (' || v_ntab || ' tablet(s), 0 stuck).'
           else '⚠ Daily check — issues:' || v_issues end
      || case when v_missing <> '' then E'\nNo tablet reporting for: ' || ltrim(v_missing, ', ') else '' end);
    update public.kiosk_alert_meta set last_summary_date = v_today where id;
  end if;
end $$;

-- ── STEP 4 — grants + schedule ───────────────────────────────────────────────────────────────
-- The kiosk PINGS the tick (idempotent + state-guarded, so this can't be used to spam).
grant execute on function public.kiosk_alert_tick() to anon, authenticated;
-- Every 5 min backstop (silence/digest). The kiosk ping covers immediacy for stuck punches.
do $$ begin perform cron.unschedule('kiosk-alert-tick'); exception when others then null; end $$;
select cron.schedule('kiosk-alert-tick', '*/5 * * * *', 'select public.kiosk_alert_tick();');

-- ── STEP 5 — RE-QUERY / CENSUS (verify) ──────────────────────────────────────────────────────
select to_regclass('public.kiosk_alert_config') as cfg, to_regclass('public.kiosk_alert_state') as st,
       to_regclass('public.kiosk_alert_meta') as meta;                                   -- all not null
select column_name from information_schema.columns
 where table_schema='public' and table_name='kiosk_health' and column_name='stuck_details';  -- 1 row
select jobname, schedule, active from cron.job where jobname = 'kiosk-alert-tick';        -- */5 * * * *, active

-- ── STEP 6 — SET THE BOT TOKEN + ALERT CHAT ID (replace placeholders, then run this) ─────────
insert into public.kiosk_alert_config (id, tg_token, alert_chat_id)
  values (true, '__PUT_BOT_TOKEN_HERE__', '__PUT_RSR_KIOSK_ALERTS_CHAT_ID_HERE__')
  on conflict (id) do update set tg_token = excluded.tg_token, alert_chat_id = excluded.alert_chat_id, updated_at = now();

-- ── STEP 7 — SMOKE TESTS (safe; run after STEP 6, during the alert window: 6 AM -> OT cut-off; then clean up) ────
-- 7a. Prove token + chat id + pg_net by sending straight to the group:
--   select public.kiosk_alert_send('✅ RSR Kiosk Alerts wired up — test message.');
--
-- 7b. STUCK alert (no trigger fuss — last_seen stays fresh):
--   insert into public.kiosk_health (device_id, site, stuck_count, queue_length, stuck_details)
--     values ('SMOKE','Carmen',1,0,
--       '[{"code":"RSR0001","name":"Juan Dela Cruz","date":"07/21","times":"in 08:00 AM, out 05:00 PM","reason":"server rejected"}]'::jsonb)
--     on conflict (device_id) do update set stuck_count=excluded.stuck_count, stuck_details=excluded.stuck_details;
--   select public.kiosk_alert_tick();   -- expect ⚠ Stuck punches — Carmen (1) • Juan Dela Cruz …
--   update public.kiosk_health set stuck_count=0, stuck_details='[]'::jsonb where device_id='SMOKE';
--   select public.kiosk_alert_tick();   -- expect ✅ Carmen — all stuck punches resolved
--
-- 7c. SILENCE alert — the trigger re-stamps last_seen, so disable it just for the test:
--   alter table public.kiosk_health disable trigger trg_kiosk_health_touch;
--   update public.kiosk_health set last_seen = now() - interval '45 minutes' where device_id='SMOKE';
--   select public.kiosk_alert_tick();   -- expect 🔴 Carmen tablet silent — last seen 45 min ago
--   alter table public.kiosk_health enable trigger trg_kiosk_health_touch;
--
-- 7d. CLEAN UP the smoke rows:
--   delete from public.kiosk_health where device_id='SMOKE';
--   delete from public.kiosk_alert_state where device_id='SMOKE';

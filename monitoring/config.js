/* ============================================================
   config.js  —  shared by every Job Monitoring screen
   DIRECT pattern: creates its own Supabase client (like kiosk/payroll).
   No dependency on ../supabase.js, so no path can 404.
   Each screen does:  import { sb, CHECKPOINTS, ... } from "./config.js";
   (Each screen's <script type="importmap"> resolves @supabase/supabase-js.)
   ============================================================ */

import { createClient } from "@supabase/supabase-js";
import { computeDiscrepancy, creditedUnits, isOverrun, closeStatusFromAudit } from "./jobclose.mjs";

const SUPABASE_URL      = "https://wpmcbjrisuyjvobvzaus.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndwbWNianJpc3V5anZvYnZ6YXVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4NjU3ODQsImV4cCI6MjA5MzQ0MTc4NH0.EGyUnXmVkUrsEteKICMRSOXURxYXPOaKUs8EYCpw6_0";

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* The 6 roll-call checkpoints — 2 hours each, last two are OT */
export const CHECKPOINTS = [
  { code: "08:30", label: "8:30 AM",  ot: false },
  { code: "11:00", label: "11:00 AM", ot: false },
  { code: "13:30", label: "1:30 PM",  ot: false },
  { code: "16:00", label: "4:00 PM",  ot: false },
  { code: "18:30", label: "6:30 PM",  ot: true  },
  { code: "20:00", label: "8:00 PM",  ot: true  },
];
export const HOURS_PER_CHECKPOINT = 2;

/* Sites used in the control number: JOB-CAR-000001 */
export const SITES = ["CAR", "MAN"];

/* ---- data helpers ---- */
export async function loadEmployees() {
  const { data, error } = await sb
    .from("employees").select("id,name,position").order("name");
  if (error) { console.error("loadEmployees", error); return []; }
  return data || [];
}

export async function loadLocations() {
  const { data, error } = await sb
    .from("work_standards").select("location,manhours_per_kg").order("location");
  if (error) { console.error("loadLocations", error); return []; }
  return data || [];
}

/* ---- date utils — all local-time, no UTC surprises ---- */
function asDate(d) { return (d instanceof Date) ? new Date(d) : new Date(d + "T00:00:00"); }
export function ymd(d) {
  const t = asDate(d);
  return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,"0")}-${String(t.getDate()).padStart(2,"0")}`;
}
export function todayLocal() { return ymd(new Date()); }
export function addDays(d, n) { const t = asDate(d); t.setDate(t.getDate()+n); return t; }
export function mondayOf(d) { const t = asDate(d); const off = (t.getDay()+6)%7; t.setDate(t.getDate()-off); return t; }
export function fmtNum(n, dp=2) { return (n==null||isNaN(n)) ? "\u2014" : Number(n).toLocaleString(undefined,{maximumFractionDigits:dp}); }

/* ---- personnel KPI (phase 1) ---- */
export { weekContaining, defaultPayWeek, isoOf } from "../shared/payweek.mjs";

// Upsert one cumulative units-to-date reading for a job on a day (unique job_id+work_date).
export async function upsertJobProgress(jobId, workDate, units, reportedBy) {
  return await sb.from("job_progress")
    .upsert({ job_id: jobId, work_date: workDate, units_cumulative: units, reported_by: reportedBy || null },
            { onConflict: "job_id,work_date" });
}

// Latest cumulative reading per job on or before a given date (for pre-filling Roll-call).
export async function loadJobProgressFor(workDate) {
  const { data, error } = await sb.from("job_progress")
    .select("job_id,work_date,units_cumulative")
    .lte("work_date", workDate)
    .order("work_date", { ascending: false });
  if (error) { console.error("loadJobProgressFor", error); return []; }
  const seen = {}, out = [];
  (data || []).forEach(r => { if (!(r.job_id in seen)) { seen[r.job_id] = 1; out.push(r); } });
  return out;
}

// ---- settings / PIN (settings is a {id,key,value} table; owner_pin has NO default) ----
export async function getSetting(key){
  const { data } = await sb.from("settings").select("value").eq("key", key).maybeSingle();
  return data ? data.value : null;
}
export async function setSetting(key, value){
  const { data } = await sb.from("settings").select("id").eq("key", key).maybeSingle();
  if (data){ const { error } = await sb.from("settings").update({ value }).eq("key", key); if (error) throw error; }
  else { const { error } = await sb.from("settings").insert({ key, value }); if (error) throw error; }
}
export async function setOwnerPin(newPin, actor){
  const existed = (await getSetting("owner_pin")) != null;
  await setSetting("owner_pin", String(newPin));
  const { error } = await sb.from("settings_audit").insert({ key:"owner_pin", action: existed?"change":"set", actor: actor||null });
  if (error) throw error;
}
export async function checkOwnerPin(pin){
  const v = await getSetting("owner_pin");
  if (v == null) return { ok:false, notSet:true };
  return { ok: String(pin) === String(v), notSet:false };
}
export async function checkCoordPin(pin){
  const v = await getSetting("coordinator_pin");
  return { ok: v != null && String(pin) === String(v) };
}

// ---- close status ----
export async function loadJobCloseStatus(jobId){
  const { data } = await sb.from("v_job_close_status").select("action,version").eq("job_id", jobId).maybeSingle();
  const action = data ? data.action : null;
  return { status: closeStatusFromAudit(action), version: data ? data.version : 0, action };
}
export async function loadAllJobCloseStatus(){
  const { data } = await sb.from("v_job_close_status").select("job_id,action,version");
  const m = {}; (data||[]).forEach(r => { m[r.job_id] = { status: closeStatusFromAudit(r.action), version:r.version, action:r.action }; });
  return m;
}

// ---- closed-week warning: weeks this job's checkpoints span that are already closed ----
export async function closedWeekWarning(jobId, actualInstalled, lastCum){
  if (Number(actualInstalled) === Number(lastCum||0)) return [];   // no earned change -> no warning
  const { data:cps } = await sb.from("job_checkpoint").select("work_date").eq("job_id", jobId);
  const weeks = [...new Set((cps||[]).map(r => weekContaining(r.work_date)))];
  const closed = [];
  for (const wk of weeks){
    const { data } = await sb.from("efficiency_week_audit").select("action").eq("week_start", wk).order("at",{ascending:false}).limit(1);
    if (data && data[0] && data[0].action === "close") closed.push(wk);
  }
  return closed;
}

// ---- Stage 1: operational close (coordinator) ----
export async function closeJobOrder(job, { actualInstalled, coordinator, coordPin, note }){
  const pc = await checkCoordPin(coordPin);
  if (!pc.ok) throw new Error("Wrong coordinator passcode.");
  const st = await loadJobCloseStatus(job.job_id);
  if (st.status !== "open") throw new Error("Job is already closed.");
  const { data:lastRows } = await sb.from("job_progress").select("units_cumulative,work_date")
    .eq("job_id", job.job_id).order("work_date",{ascending:false}).limit(1);
  const lastCum = (lastRows && lastRows[0]) ? Number(lastRows[0].units_cumulative) : null;
  // Supersede the last cumulative with the final installed quantity (final job_progress row, today).
  await upsertJobProgress(job.job_id, todayLocal(), Number(actualInstalled), coordinator || null);
  // Read the recomputed settlement to freeze it.
  const { data:eff } = await sb.from("v_job_efficiency").select("*").eq("job_id", job.job_id).maybeSingle();
  const disc = computeDiscrepancy(Number(actualInstalled), lastCum, job.unit);
  const target = job.quantity;   // jobs.quantity (target) — do NOT write it
  const credited = creditedUnits(Number(actualInstalled), target);
  const over = isOverrun(Number(actualInstalled), target);
  const { data:mv } = await sb.from("job_close").select("close_version").eq("job_id", job.job_id).order("close_version",{ascending:false}).limit(1);
  const version = ((mv && mv[0] && mv[0].close_version) || 0) + 1;
  const ins = await sb.from("job_close").insert({
    job_id: job.job_id, close_version: version, actual_installed: Number(actualInstalled),
    last_rollcall_units: lastCum, target_quantity: target, credited_units: credited,
    earned_hours: eff ? eff.earned_hours : null, actual_hours: eff ? eff.actual_hours : null,
    efficiency: eff ? eff.efficiency : null, overrun: over,
    discrepancy_delta: disc.delta, discrepancy_pct: disc.pct,
    calibrated_at_close: !!job.calibrated, closed_by: coordinator || null,
  });
  if (ins.error) throw new Error(ins.error.message);
  const aud = await sb.from("job_close_audit").insert({
    job_id: job.job_id, action: "operational_close", version, actor: coordinator || null, note: note || disc.text });
  if (aud.error) throw new Error(aud.error.message);
  const upd = await sb.from("jobs").update({ status: "closed" }).eq("id", job.job_id);   // freeze (status only)
  if (upd.error) throw new Error(upd.error.message);
  return { version, disc, credited, over };
}

// ---- Stage 2: incentive approval (owner) ----
export async function approveJob(job, { ownerPin, owner }){
  const st = await loadJobCloseStatus(job.job_id);
  if (st.status !== "pending") throw new Error("Job is not pending approval.");
  if (!job.calibrated) throw new Error("Calibrate the job before approving.");
  const chk = await checkOwnerPin(ownerPin);
  if (chk.notSet) throw new Error("OWNER_PIN_NOT_SET");
  if (!chk.ok) throw new Error("Wrong owner passcode.");
  const aud = await sb.from("job_close_audit").insert({ job_id: job.job_id, action:"incentive_approve", version: st.version, actor: owner || null, note: null });
  if (aud.error) throw new Error(aud.error.message);
  return { version: st.version };
}

// ---- Reopen (owner, any stage) ----
export async function reopenJob(job, { ownerPin, owner, reason }){
  const st = await loadJobCloseStatus(job.job_id);
  if (st.status === "open") throw new Error("Job is not closed.");
  const chk = await checkOwnerPin(ownerPin);
  if (chk.notSet) throw new Error("OWNER_PIN_NOT_SET");
  if (!chk.ok) throw new Error("Wrong owner passcode.");
  const aud = await sb.from("job_close_audit").insert({ job_id: job.job_id, action:"reopen", version: st.version, actor: owner || null, note: reason || null });
  if (aud.error) throw new Error(aud.error.message);
  const upd = await sb.from("jobs").update({ status: "ongoing" }).eq("id", job.job_id);   // un-freeze
  if (upd.error) throw new Error(upd.error.message);
  return {};
}

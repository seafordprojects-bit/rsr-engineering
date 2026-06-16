/* ============================================================
   config.js  —  shared helpers for the Job Monitoring screens
   IMPORT PATTERN: borrows the Supabase client from ./supabase.js
   (same as home.js / coordinator.js). No key lives here.
   Each screen does:  import { sb, CHECKPOINTS, ... } from './config.js';
   ============================================================ */

import { supabase } from "./supabase.js";

/* re-export the shared client under the name the screens use */
export const sb = supabase;

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

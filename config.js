/* ============================================================
   config.js  —  shared by every Job Monitoring screen
   Load order in each HTML:
     1) supabase-js (CDN)   2) this file   3) the screen's module script
   ============================================================ */

/* ---- PASTE YOUR PROJECT VALUES (copy from any existing app file) ---- */
const SUPABASE_URL      = "https://wpmcbjrisuyjvobvzaus.supabase.co"; // confirm this is the kiosk project
const SUPABASE_ANON_KEY = "PASTE_YOUR_ANON_KEY_HERE";                 // public anon key — same one your other apps use
/* -------------------------------------------------------------------- */

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* The 6 roll-call checkpoints — 2 hours each, last two are OT */
const CHECKPOINTS = [
  { code: "08:30", label: "8:30 AM",  ot: false },
  { code: "11:00", label: "11:00 AM", ot: false },
  { code: "13:30", label: "1:30 PM",  ot: false },
  { code: "16:00", label: "4:00 PM",  ot: false },
  { code: "18:30", label: "6:30 PM",  ot: true  },
  { code: "20:00", label: "8:00 PM",  ot: true  },
];
const HOURS_PER_CHECKPOINT = 2;

/* Sites used in the control number: JOB-CAR-000001 */
const SITES = ["CAR", "MAN"];

/* ---- helpers ---- */
async function loadEmployees() {
  const { data, error } = await sb
    .from("employees").select("id,name,position").order("name");
  if (error) { console.error("loadEmployees", error); return []; }
  return data || [];
}

async function loadLocations() {
  const { data, error } = await sb
    .from("work_standards").select("location,manhours_per_kg").order("location");
  if (error) { console.error("loadLocations", error); return []; }
  return data || [];
}

/* date utils — all local-time, no UTC surprises */
function asDate(d) { return (d instanceof Date) ? new Date(d) : new Date(d + "T00:00:00"); }
function ymd(d) {
  const t = asDate(d);
  return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,"0")}-${String(t.getDate()).padStart(2,"0")}`;
}
function todayLocal() { return ymd(new Date()); }
function addDays(d, n) { const t = asDate(d); t.setDate(t.getDate()+n); return t; }
function mondayOf(d) { const t = asDate(d); const off = (t.getDay()+6)%7; t.setDate(t.getDate()-off); return t; }
function fmtNum(n, dp=2) { return (n==null||isNaN(n)) ? "\u2014" : Number(n).toLocaleString(undefined,{maximumFractionDigits:dp}); }

window.RSR = {
  sb, CHECKPOINTS, HOURS_PER_CHECKPOINT, SITES,
  loadEmployees, loadLocations,
  ymd, todayLocal, addDays, mondayOf, fmtNum,
};

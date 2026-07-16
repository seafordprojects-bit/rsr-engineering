/* ============================================================
   rollcall-core.js — shared gate + helpers for the roll-call phone surfaces.

   Both roll-call.html (attendance) and borrow.html (tool borrowing) are the SAME registered
   field phone, behind the SAME three checks: ?site= yard, roll-call passcode, one-device lock.
   That gate lives here ONCE so the two surfaces can never drift apart — a change to the device
   lock or passcode rule applies to both. Each page supplies its own `App` component; Shell runs
   the gate and renders that App with { site, siteCode, siteId } once all three checks pass.

   Resolves via the host page's <script type="importmap"> (preact/hooks/htm) and config.js (sb).
   ============================================================ */
import { h } from "preact";
import { useState, useEffect } from "preact/hooks";
import htm from "htm";
import { sb } from "./config.js";
const html = htm.bind(h);

// --- settings helpers (mirror home.js select-then-update-or-insert) ---
export async function getSetting(key){
  const { data } = await sb.from("settings").select("value").eq("key", key).limit(1);
  return data && data.length ? data[0].value : null;
}
export async function setSetting(key, value){
  const { data } = await sb.from("settings").select("id").eq("key", key).limit(1);
  if (data && data.length) { await sb.from("settings").update({ value }).eq("key", key); }
  else { await sb.from("settings").insert({ key, value }); }
}
export const DEVKEY = "rsr_rollcall_device";
export function newToken(){
  try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch(_){}
  return String(Date.now()) + "-" + Math.round(Math.random() * 1e9);
}

// --- yard (site) helpers -------------------------------------------------
// The yard list is DATA (settings.attendance_sites — the same list the kiosk reads), never a
// hardcoded list here. A new yard added to that array works with no code change.
export async function siteList(){
  try {
    const raw = await getSetting("attendance_sites");
    const arr = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(arr) ? arr.map(x => String(x).trim()).filter(Boolean) : [];
    // Cache for the locked field-phone menu (monitoring/index.html), which renders yard tiles
    // instantly from this even offline. Shared key with the kiosk's yard cache.
    try { if (list.length) localStorage.setItem("rsr_sites", JSON.stringify(list)); } catch(_){}
    return list;
  } catch(_) { return []; }
}
// Roll-call entries store the yard NAME ("Carmen"); jobs store the CODE ("CAR"); tool borrows
// store the site's id (UUID). All three come from the shared `sites` table — read only, the
// inventory system owns it. Its stale "Site A"/"Site B" rows can never match, because we only
// look up names present in attendance_sites.
export async function siteRowFor(name){
  const { data } = await sb.from("sites").select("id,code,name");
  return (data||[]).find(s => String(s.name).trim().toLowerCase() === String(name).trim().toLowerCase()) || null;
}

// --- tool-borrow helpers (REUSE borrow_issuance + next_no; no parallel system) ------------
// Available tool units at a yard = active units at the site minus anything currently out.
export async function loadAvailTools(siteId){
  if(!siteId) return [];
  const ures = await sb.from("item_units").select("id,unit_code,status,item_id,items(name,item_code,price)").eq("active",true).eq("site_id",siteId);
  const bres = await sb.from("borrow_issuance").select("unit_id").eq("status","out").eq("site_id",siteId);
  const out = new Set((bres.data||[]).map(b=>b.unit_id));
  const map={};
  (ures.data||[]).forEach(u=>{
    if(u.status!=="available" || out.has(u.id)) return;
    const k=u.item_id;
    if(!map[k]) map[k]={itemId:k, name:(u.items&&u.items.name)||"—", price:(u.items&&u.items.price)||0, units:[]};
    map[k].units.push({id:u.id, code:u.unit_code});
  });
  return Object.values(map).sort((a,b)=>a.name.localeCompare(b.name));
}
// Who holds a unit that is out, on which slip, since when — so a rejection names a person.
export async function describeUnitHolder(unitId){
  try{
    const { data } = await sb.from("borrow_issuance")
      .select("slip_no,borrowed_at,employees(name)").eq("unit_id",unitId).eq("status","out").limit(1);
    const r=(data||[])[0]; if(!r) return null;
    return { name:(r.employees&&r.employees.name)||"someone", slip_no:r.slip_no,
             since:r.borrowed_at?String(r.borrowed_at).slice(0,10):"" };
  }catch(_){ return null; }
}

// --- passcode + one-device gate ------------------------------------------
function Gate({ site, siteCode, siteId, App }){
  const [phase, setPhase] = useState("checking"); // checking|blocked|nopin|need|ok
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { (async () => {
    try {
      const localTok = localStorage.getItem(DEVKEY);
      const [regId, cfgPin] = await Promise.all([
        getSetting("roll_call_device_id"), getSetting("roll_call_pin"),
      ]);
      if (regId && localTok !== regId) { setPhase("blocked"); return; }
      if (!cfgPin) { setPhase("nopin"); return; }
      setPhase("need");
    } catch (e) {
      setErr("Could not reach the server. Check the connection and reload.");
      setPhase("need");
    }
  })(); }, []);

  async function submit(e){
    if (e && e.preventDefault) e.preventDefault();
    if (busy) return;
    setErr("");
    const entry = pin.trim();
    if (!entry) { setErr("Enter the passcode."); return; }
    setBusy(true);
    try {
      const cfgPin = await getSetting("roll_call_pin");
      if (!cfgPin) { setBusy(false); setPhase("nopin"); return; }
      if (entry !== String(cfgPin)) { setBusy(false); setErr("Wrong passcode."); setPin(""); return; }
      // passcode correct — enforce / claim the one-device lock
      const regId = await getSetting("roll_call_device_id");
      let localTok = localStorage.getItem(DEVKEY);
      if (regId && localTok !== regId) { setBusy(false); setPhase("blocked"); return; }
      if (!regId) {
        const tok = localTok || newToken();
        localStorage.setItem(DEVKEY, tok);
        await setSetting("roll_call_device_id", tok);
      }
      setBusy(false); setPhase("ok");
    } catch (err) {
      setBusy(false); setErr("Could not verify: " + err.message);
    }
  }

  if (phase === "checking") return html`<div class="loading">Checking device&hellip;</div>`;
  if (phase === "ok") return html`<${App} site=${site} siteCode=${siteCode} siteId=${siteId} />`;
  if (phase === "blocked") return html`
    <div class="gate">
      <div class="gicon">⛔</div>
      <h2>This phone isn't the roll-call device</h2>
      <p>Roll-call is locked to one registered phone. Ask the admin to reset the roll-call device
         (Admin &rarr; Settings &rarr; Roll-call phone) if this phone should take over.</p>
    </div>`;
  if (phase === "nopin") return html`
    <div class="gate">
      <div class="gicon">\u{1F512}</div>
      <h2>Roll-call passcode not set</h2>
      <p>Ask the admin to set the roll-call passcode in Admin &rarr; Settings &rarr; Roll-call phone,
         then reload this page.</p>
    </div>`;
  return html`
    <form class="gate" onSubmit=${submit}>
      <div class="gicon">\u{1F4F1}</div>
      <h2>Roll-call</h2>
      <p>Enter the roll-call passcode.</p>
      <input class="gpin" type="password" inputmode="numeric" autocomplete="off" value=${pin}
             onInput=${e => setPin(e.target.value)} placeholder="passcode" autofocus />
      ${err && html`<div class="gerr">${err}</div>`}
      <button class="gbtn" type="submit" disabled=${busy}>${busy ? "Checking…" : "Unlock"}</button>
    </form>`;
}

// --- yard gate: ?site= decides the yard. REFUSE rather than guess ---------
// Outermost on purpose: a missing/unknown yard is a URL problem, so there is no point making the
// in-charge type the passcode first only to be turned away. Defaulting to a yard is never an
// option — a wrong-yard entry is silently wrong data, which is worse than a blocked screen.
// Renders the given `App` once the yard is known and the passcode/device gate passes.
export function Shell({ App }){
  const [phase,setPhase] = useState("checking");   // checking|noyards|nosite|badsite|ok
  const [yards,setYards] = useState([]);
  const [asked,setAsked] = useState("");
  const [site,setSite]   = useState("");
  const [code,setCode]   = useState(null);
  const [siteId,setSiteId] = useState(null);

  useEffect(() => { (async () => {
    const list = await siteList();
    setYards(list);
    const want = (new URLSearchParams(location.search).get("site") || "").trim();
    setAsked(want);
    if (!list.length) { setPhase("noyards"); return; }
    if (!want) { setPhase("nosite"); return; }
    const hit = list.find(n => n.toLowerCase() === want.toLowerCase());
    if (!hit) { setPhase("badsite"); return; }
    setSite(hit);
    const row = await siteRowFor(hit);
    setCode(row ? row.code : null);
    setSiteId(row ? row.id : null);
    setPhase("ok");
  })(); }, []);

  // The badge lives in the static header, outside the app root.
  useEffect(() => {
    const el = document.getElementById("site-badge");
    if (el) el.textContent = (phase === "ok") ? site : "";
  }, [phase, site]);

  if (phase === "checking") return html`<div class="loading">Checking site&hellip;</div>`;
  if (phase === "ok") return html`<${Gate} site=${site} siteCode=${code} siteId=${siteId} App=${App} />`;
  if (phase === "noyards") return html`
    <div class="gate">
      <div class="gicon">\u{1F3D7}</div>
      <h2>Wala pa na-set ang yard</h2>
      <p>Palihug adto sa Admin aron ma-set ang listahan sa yard, unya i-reload ni nga page.</p>
    </div>`;
  if (phase === "badsite") return html`
    <div class="gate">
      <div class="gicon">\u{2753}</div>
      <h2>Wala mailhi nga site: ${asked}</h2>
      <p>Ablihi ni gikan sa shortcut sa home screen: ${yards.join(" o ")}.</p>
    </div>`;
  return html`
    <div class="gate">
      <div class="gicon">\u{1F4CD}</div>
      <h2>Asa nga yard?</h2>
      <p>Ablihi ni nga page gikan sa shortcut sa home screen: ${yards.join(" o ")}.</p>
    </div>`;
}

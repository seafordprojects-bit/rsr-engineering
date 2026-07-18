/* ============================================================
   vessel.mjs — pure vessel-lifecycle helpers (no Supabase import → node-testable,
   mirrors jobclose.mjs). A voyage row comes from the `voyages` table.
   ============================================================ */

// Is the vessel currently in the yard (an active repair phase)? Mirrors the tool-borrow /
// material-issuance filter byte-for-byte.
export function activeInYard(v){
  if(!v) return false;
  if(v.status==='finished' || v.status==='not_active') return false;
  const dry=(v.docking_date || v.status==='drydock') && !v.undocking_date;
  const afl=v.afloat_start && !v.afloat_done;
  const eme=v.emergency_start && !v.emergency_end;
  return !!(dry||afl||eme);
}

// Flag an OPEN job whose linked vessel has LEFT the yard. Returns null (no flag) or
// { reason, message }. `voyageById` maps voyage_id -> voyage row (a Map or a plain object).
export function vesselFlag(job, voyageById){
  if(!job || !job.voyage_id) return null;                       // legacy / unlinked → never flagged
  const st=String(job.status||"").toLowerCase();
  if(st==="done" || st==="closed") return null;                 // already finished
  const v=voyageById && (voyageById.get ? voyageById.get(job.voyage_id) : voyageById[job.voyage_id]);
  if(!v) return null;                                           // vessel row missing → don't flag
  if(activeInYard(v)) return null;                              // still in the yard → no flag
  const ends=[
    { reason:"Vessel undocked",        d:v.undocking_date },
    { reason:"Afloat repair ended",    d:v.afloat_done },
    { reason:"Emergency repair ended", d:v.emergency_end },
  ].filter(x=>x.d);
  ends.sort((a,b)=> String(b.d).localeCompare(String(a.d)));    // latest end date first
  const reason = ends.length ? ends[0].reason : "Vessel left the yard";
  return { reason, message: reason + " — close this job order" };
}

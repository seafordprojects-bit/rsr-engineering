// shared/payweek.mjs
// SINGLE SOURCE OF TRUTH for the RSR pay-week boundary (Saturday -> Friday).
// VERBATIM transcription of payroll/index.html:436 (isoOf) and 635-644 (setWeek).
// payroll/index.html still carries its own inline copy today and MUST stay byte-
// identical in this workstream; monitoring/diagnostic.html asserts the two never
// drift. Converge payroll onto this file on the next payroll-initiated change.

// payroll/index.html:436 -- local YYYY-MM-DD, no UTC shift
export function isoOf(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}

// Saturday on/before d. Mirrors payroll sinceSat=(getDay()+1)%7 (Sat=0..Fri=6), payroll/index.html:640
export function saturdayOnOrBefore(d){
  const x=new Date(d); x.setHours(0,0,0,0);
  const sinceSat=(x.getDay()+1)%7;
  x.setDate(x.getDate()-sinceSat);
  return x;
}

// Pay week (Sat->Fri) CONTAINING dateStr 'YYYY-MM-DD'. Pure; used to bucket a work_date.
export function weekContaining(dateStr){
  const sat=saturdayOnOrBefore(new Date(dateStr+'T00:00:00'));
  const fri=new Date(sat); fri.setDate(sat.getDate()+6);
  return { start: isoOf(sat), end: isoOf(fri) };
}

// Default selected pay week for the Close-week screen. VERBATIM mirror of payroll
// setWeek(offset), payroll/index.html:636-642: reference from YESTERDAY so payday-
// Saturday shows the week that just ended. offset 0 = current, -1 = previous.
export function defaultPayWeek(offset=0, now=new Date()){
  const ref=new Date(now); ref.setDate(ref.getDate()-1); ref.setHours(0,0,0,0);
  const sinceSat=(ref.getDay()+1)%7; // Sat=0, Sun=1, ... Fri=6
  const sat=new Date(ref); sat.setDate(ref.getDate()-sinceSat+offset*7);
  const fri=new Date(sat); fri.setDate(sat.getDate()+6);
  return { start: isoOf(sat), end: isoOf(fri) };
}

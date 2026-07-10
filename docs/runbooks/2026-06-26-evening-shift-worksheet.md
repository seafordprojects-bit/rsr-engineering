# 06-26 evening-shift reconstruction worksheet

**Owner decisions (2026-07-10):** Groups A/B → **break-adjusted** (dinner break deducted).
Group D → **clear the stray PM-In, Time Out at the real departure.** Group E + the sparse
rows → **held** (owner will resolve after asking the workers).

All entries applied via payroll **✎ Edit-times** (24-hour / military time). Each save recomputes
hours + pay and writes an `attendance_edit_audit` row (reason + owner passcode).

> **Engine caveat (why the restructure):** for an **afternoon-start** row (Time In ≥ 12:40 PM),
> the payroll engine does **not** deduct a break recorded in the *lunch* slots — a lone Time Out
> would credit on-site time (~1h high). Recording the ~5 PM break in the **PM-break slots**
> (`pm_out`/`pm_in`) is both semantically correct for an evening shift and makes the engine
> deduct it. Evening credit floors to 6:00 PM, so the result runs ~0.1–0.2h under a hand
> figure — that gap is genuine unpaid time between the break-in and 6 PM. Exact modelling of
> afternoon+break shifts is what the deferred Night-Duty pay pipeline will add.

## Group A — afternoon→night shifts (break-adjusted)
Move the ~5 PM break out of the lunch slots into the PM-break slots; set Time Out = the late
departure. **Clear `lunch_out` and `lunch_in`.**

| Code | Name | timein | pm_out | pm_in | timeout | clear | → credits |
|------|------|--------|--------|-------|---------|-------|-----------|
| RSR 0024 | Tomas Monterde | 1258 | 1650 | 1750 | 2352 | lunch_out, lunch_in | **9.7h** |
| RSR 0022 | Presillas Christian | 1259 | 1657 | 1757 | 2349 | lunch_out, lunch_in | **9.8h** |
| RSR 0013 | Johnlie Lato | 1256 | 1652 | 1752 | 2340 | lunch_out, lunch_in | **9.5h** |
| RSR 0033 | Junrey Ricaplaza | 1259 | 1647 | 1747 | 2041 | lunch_out, lunch_in | **6.5h** |

## Group B — short afternoon shifts, left after the break (break-adjusted)
Break-out into `pm_out`, Time Out = when they left (end of break). **Clear `lunch_out`,
`lunch_in`, `pm_in`.**

| Code | Name | timein | pm_out | timeout | clear | → credits |
|------|------|--------|--------|---------|-------|-----------|
| RSR 0009 | Glicerio Terce Jr. | 1259 | 1652 | 1752 | lunch_out, lunch_in, pm_in | **3.9h** |
| RSR 0008 | Jeffrey Panday | 1258 | 1651 | 1751 | lunch_out, lunch_in, pm_in | **3.9h** |

## Group D — clear stray PM-In, Time Out at real departure
These punched a PM-In (return from break) before 6 PM and then left without a Time Out; leaving
the PM-In and adding a Time Out would balloon to ₱0. **Clear `pm_in`**, set Time Out = departure.

| Code | Name | keep | pm_out | timeout | clear | → credits |
|------|------|------|--------|---------|-------|-----------|
| RSR 0005 | Alvin H. Operio | timein 0800, lunch 1143/1258 | 1657 | 1748 | pm_in | **7.7h** |
| RSR 0035 | Allan Manos | timein 1303 | 1700 | 1752 | pm_in | **4.0h** |
| RSR 0003 | Razel Medio | timein 1303 | 1648 | 1745 | pm_in | **3.8h** |

## Held — Group E + sparse (owner to resolve after asking the workers)
- **RSR 0031** Anthony Capuyan — in 8 AM, then "lunch 4:53–5:53 PM" (nonsensical), no other punch → credits 0h. Likely a normal ~8 AM–5 PM day with mis-slotted punches.
- **RSR 0025** Jamaica Batucan — only in 11:33 AM + lunch-out 12:23 PM. Half-morning or abandoned session.
- **RSR 0014** (in 1:00 PM only), **RSR 0019** (in 1:02 PM only), **RSR 0032** (in **11:40 PM** only — night arrival?). Single punch each — likely absent/mispunch.

## No action (already have a Time Out, paying)
RSR 0002 (7.0h), RSR 0010 (7.1h), RSR 0015 (9.9h), RSR 0016 (7.1h), RSR 0026 (11.0h), RSR 0030 (6.9h).

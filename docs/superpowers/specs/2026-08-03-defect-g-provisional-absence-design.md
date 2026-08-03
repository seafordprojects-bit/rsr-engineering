# Defect G — the one-tap provisional absence row

**Status:** design, not built. Read before implementation per the walkthrough gate.
**Motivating incident:** rev2 §4.1 — RSR 0015 reported six days in advance to Jamaica, nothing was
entered, and a factually wrong NTE reached paper one hand-over from service.

**The requirement, from §4.1:** *any reported absence must produce a dated row THAT DAY, even one-tap
provisional, pending approval.* The row is not the approval. **It is the evidence that he spoke.**

---

## 1. Where it lives — reuse `leave_requests`, do not build a table

Three properties make this the right home, all verified 2026-08-03:

- **The chain already reads it.** `isAbsentOnDate` and `onLeaveToday` (kiosk) and A5's `BREAK` clause
  all consult `leave_requests`. Surfacing becomes **one predicate change**, not a new data path, a
  new sync, or new grants.
- **Pay-neutral by construction.** `payroll/index.html:735` pays only
  `LEAVE_PAID = {'Vacation Leave','Sick Leave'}`; anything else counts as unpaid days. And payroll
  selects `.eq('status','Approved')`, so a provisional row is invisible to it entirely.
- **No enum to migrate.** `status` is free text and already carries `Pending`, `Approved`, `Rejected`,
  `Filed`, `Auto-detected`, `Filed with Time In`.

A separate table would need its own sync, its own grants, its own read in four places, and would
still have to be joined into the same predicate. Nothing is gained.

## 2. The row — minimal, and what each field is for

| Column | Value | Why |
|---|---|---|
| `employee_code`, `employee_name` | the absent man | — |
| `type` | **`'Reported Absence'`** | new; outside `LEAVE_PAID`, so pay-neutral without touching payroll |
| `start_date`, `end_date`, `days` | the dates reported | what the chain reads |
| `status` | **`'Provisional'`** | new; distinguishes "he told someone" from "it was approved" |
| `filed_by` | **who tapped it** | the accountable entry, not the reporter |
| `filed_on` | today | proves it was entered ON THE DAY, which is the whole requirement |
| `reported_to` | **NEW nullable column** | who he told — Jamaica, the owner, a coordinator |
| `reported_how` | **NEW nullable column** | text, call, in person, through a workmate |

Both new columns are **nullable and additive**. Payroll reads `select('*')`, so they arrive
harmlessly. Putting them in `reason` as free text was the alternative and is rejected: this row can
end up in a disciplinary file, and "who he told and how" is exactly what gets contested.

**`filed_by` and `reported_to` are deliberately separate.** In the motivating incident they would
have been the same person; for Allan and Art they would not. Collapsing them loses the chain of
custody.

## 3. Where it surfaces — one predicate, and it closes E at the same time

Today four places ask "is this date explained?" and every one tests `status === 'Approved'`:

- `kiosk isAbsentOnDate` — chain-breaking
- `kiosk onLeaveToday` — sweep skip
- A5's `BREAK` clause — the hold-list query
- the walkthrough files' `BREAK` logic (same SQL)

**Replace the single-status test with a set.** One shared definition of *suppressing*:

```
SUPPRESSING = { 'Approved', 'Provisional', 'Pending' }
```

- `Approved` — today's behaviour, unchanged.
- `Provisional` — **Defect G.** He told someone; it is recorded; he is not flagged while it stands.
- `Pending` — **Defect E.** A filed-but-undecided leave stops suppressing nothing.

**G and E collapse into the same one-line change.** They were always the same defect wearing two
hats: the system had no way to know a date was explained. Building G without E would mean writing
the predicate twice.

**Note the interaction with `awol_set_suspended`:** the sweep must consult this before opening a
case, not after. A provisional row entered at 08:00 must prevent the 3-day chain from ever reaching
the RPC — otherwise the case opens and something has to cancel it, which is the shape that produced
`awol_cancel_leave_approved` and its audit ambiguity.

---

## 4. FOUR DECISIONS I CANNOT MAKE — they change what the system does for the business

### 4a. Who may enter one?

**This is the question the incident answers least clearly.** The three known cases reported to
**three different people**: Niño told **Jamaica**; Allan and Art told **the owner**. A
Jamaica-only tool would have caught the incident that motivated this and missed the two before it.

| Option | Catches | Cost |
|---|---|---|
| **Jamaica only**, admin dashboard | Niño's case | misses anything reported to the owner or a coordinator; she becomes a bottleneck when absent |
| **Jamaica + owner** | all three known cases | two surfaces to build |
| **+ yard coordinators** | anything reported at the yard | more hands on a disciplinary-adjacent record; needs its own audit thought |

*Concrete example:* a man phones the Carmen coordinator at 6 AM to say his child is in hospital. If
coordinators cannot enter it, that absence is invisible until someone tells Jamaica — which is
exactly how six days went unrecorded.

### 4b. Does a provisional row suppress detection immediately, or only once approved?

*Concrete example:* a man tells Jamaica he will be out Monday to Wednesday. She taps it Monday
morning. **Immediately:** he is never flagged, and if the reason turns out to be false the row is
rejected afterwards and the absence counts from then. **Only on approval:** if the owner does not
decide until Thursday, the detector flags him Wednesday and the case has to be cancelled.

I recommend **immediately** — that is the entire point of recording it on the day — but it means an
unapproved claim suppresses detection, and that is a policy choice about trust, not a technical one.

### 4c. What happens to a provisional row nobody ever decides?

*Concrete example:* Jamaica taps it Monday; nobody approves or rejects it; it is still `Provisional`
in September. Options: it stands indefinitely; it expires after N days and detection resumes; or it
appears on a "waiting for your decision" list until acted on. **Silent indefinite suppression is the
failure mode to avoid** — it is the same shape as the walkthrough holds that must never be forgotten.

### 4d. Does the worker see anything?

*Concrete example:* he returns Thursday and keys in. Does the kiosk say *"your reported absence for
Mon–Wed is recorded, waiting for approval"*? It would tell him he was believed, which is the
opposite of what §4.1 describes. But it is another worker-facing string, and §3.8's rules apply —
named, non-blocking, asserting only what the row actually says.

---

## 5. Build order, once 4a–4d are answered

1. **Two nullable columns** on `leave_requests` — additive, no behaviour change, verify payroll and
   the dashboard still load.
2. **The suppressing-status set**, in all four read sites at once. This is the change that closes
   both G and E; it must not ship in one place and not another.
3. **The entry surface**, per 4a.
4. **Acceptance walkthrough as the ship gate**, in the shape that worked for PAHIBALO: a staged
   worker with a 3+ day chain, a provisional row entered, and the sweep **failing to open a case**.
   The assertion is the absence of a case row — and, per §14, the evidence must be read **before**
   the teardown removes it.

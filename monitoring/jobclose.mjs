// Pure helpers for Close-job-order. No DB, no DOM — unit-testable.

// Credited units are capped at target; a null target is never payable (null).
export function creditedUnits(actualInstalled, target) {
  if (target == null) return null;
  return Math.min(Number(actualInstalled), Number(target));
}

// Installing beyond target is an overrun (earns nothing on the overage).
export function isOverrun(actualInstalled, target) {
  return target != null && Number(actualInstalled) > Number(target);
}

// Discrepancy of actual-installed vs the last roll-call cumulative.
// base = last cumulative (0 when none). Uses a real minus sign (U+2212) for display.
export function computeDiscrepancy(actualInstalled, lastCumulative, unit) {
  const base = (lastCumulative == null ? 0 : Number(lastCumulative));
  const delta = Math.round((Number(actualInstalled) - base) * 1000) / 1000;
  const pct = base > 0 ? Math.round((delta / base) * 1000) / 10 : null;
  if (delta === 0) return { delta: 0, pct, text: 'matches last report' };
  const u = unit || 'units';
  const sign = delta > 0 ? '+' : '−';
  let text = `${sign}${Math.abs(delta)} ${u} vs last roll-call report`;
  if (pct != null) text += ` (${delta > 0 ? '+' : '−'}${Math.abs(pct)}%)`;
  return { delta, pct, text };
}

// Current close status from the latest audit action for a job.
export function closeStatusFromAudit(latestAction) {
  if (latestAction === 'operational_close') return 'pending';
  if (latestAction === 'incentive_approve') return 'approved';
  return 'open'; // 'reopen' or none
}

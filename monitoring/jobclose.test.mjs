import assert from 'node:assert/strict';
import { creditedUnits, isOverrun, computeDiscrepancy, closeStatusFromAudit } from './jobclose.mjs';
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok', name); };

t('creditedUnits caps at target', () => { assert.equal(creditedUnits(420, 400), 400); assert.equal(creditedUnits(380, 400), 380); });
t('creditedUnits null target -> null', () => { assert.equal(creditedUnits(400, null), null); });
t('isOverrun', () => { assert.equal(isOverrun(420, 400), true); assert.equal(isOverrun(400, 400), false); assert.equal(isOverrun(400, null), false); });
t('discrepancy exact match', () => { const d = computeDiscrepancy(400, 400, 'kg'); assert.equal(d.delta, 0); assert.equal(d.text, 'matches last report'); });
t('discrepancy under', () => { const d = computeDiscrepancy(388, 400, 'kg'); assert.equal(d.delta, -12); assert.equal(d.pct, -3); assert.equal(d.text, '−12 kg vs last roll-call report (−3%)'); });
t('discrepancy over', () => { const d = computeDiscrepancy(410, 400, 'kg'); assert.equal(d.delta, 10); assert.equal(d.pct, 2.5); assert.equal(d.text, '+10 kg vs last roll-call report (+2.5%)'); });
t('discrepancy no prior (base 0) -> pct null', () => { const d = computeDiscrepancy(400, null, 'kg'); assert.equal(d.pct, null); assert.equal(d.text, '+400 kg vs last roll-call report'); });
t('closeStatusFromAudit', () => { assert.equal(closeStatusFromAudit('operational_close'), 'pending'); assert.equal(closeStatusFromAudit('incentive_approve'), 'approved'); assert.equal(closeStatusFromAudit('reopen'), 'open'); assert.equal(closeStatusFromAudit(null), 'open'); });

console.log(`\n${n} tests passed`);

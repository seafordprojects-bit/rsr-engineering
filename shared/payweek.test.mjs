import { test } from "node:test";
import assert from "node:assert/strict";
import { saturdayOnOrBefore, weekContaining, defaultPayWeek } from "./payweek.mjs";

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;

test("saturdayOnOrBefore snaps to the Saturday on/before", () => {
  assert.equal(iso(saturdayOnOrBefore(new Date("2026-07-04T12:00:00"))), "2026-07-04"); // Sat -> itself
  assert.equal(iso(saturdayOnOrBefore(new Date("2026-07-03T12:00:00"))), "2026-06-27"); // Fri -> prev Sat
  assert.equal(iso(saturdayOnOrBefore(new Date("2026-07-10T12:00:00"))), "2026-07-04"); // Fri end -> its Sat
});

test("weekContaining returns the Sat-Fri window", () => {
  assert.deepEqual(weekContaining("2026-07-06"), { start: "2026-07-04", end: "2026-07-10" }); // Mon
  assert.deepEqual(weekContaining("2026-07-03"), { start: "2026-06-27", end: "2026-07-03" }); // Fri (week end)
  assert.deepEqual(weekContaining("2026-07-04"), { start: "2026-07-04", end: "2026-07-10" }); // Sat (week start)
});

test("defaultPayWeek mirrors payroll: on payday Sat it shows the week that just ended", () => {
  // payroll comment: on Sat Jul 4 it loads Jun 27 -> Jul 3
  assert.deepEqual(defaultPayWeek(0, new Date("2026-07-04T09:00:00")), { start: "2026-06-27", end: "2026-07-03" });
  assert.deepEqual(defaultPayWeek(-1, new Date("2026-07-04T09:00:00")), { start: "2026-06-20", end: "2026-06-26" });
});

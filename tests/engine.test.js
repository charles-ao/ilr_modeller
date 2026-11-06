// Acceptance and unit tests for engine.js (REQUIREMENTS.md section 12).
// Runs in the browser via engine.test.html, or in Node with:  node tests/engine.test.js
// Plain script (no ES modules) so it also works when opened straight from disk.

(function (root) {
"use strict";

const isNode = typeof module === "object" && module.exports;
const RULES = isNode ? require("../config.js").RULES : root.ILR_RULES;
const {
  validate, analyseScenario, buildTimeline, evaluateAt, countedYears, explain,
  parseMonth, formatMonth, formatDate, formatGBP, parseSalary, encodeState, decodeState,
  toCSV, BASES
} = isNode ? require("../engine.js") : root.ILREngine;

const AS_OF = parseMonth("2026-11");

function scenarioFor(history, routeStart, extra = {}) {
  return {
    version: 1,
    routeStart,
    history: history.map(([from, salary]) => ({ from, salary })),
    scenarios: {
      A: { label: "Keep current salary", mode: "keep" },
      B: { label: "Projected", mode: "projected", changes: [], growthPct: 0 }
    },
    applyIn: null,
    ...extra
  };
}

function run(raw, key = "A") {
  const v = validate(raw, RULES, { asOf: AS_OF });
  if (!v.ok) throw new Error("Invalid input: " + JSON.stringify(v.errors));
  return analyseScenario(v.model, key, RULES, { asOf: AS_OF });
}

const short = (idx) => (idx === null ? "Not reached" : formatMonth(idx).replace(/^(\w{3})\w*/, "$1"));

const AT01 = scenarioFor([["2021-10", 45000], ["2023-10", 54000]], "2021-10");

const acceptance = [
  { id: "AT-01", raw: AT01, route: 5, expect: { tax: "Apr 2027", calendar: "Jan 2027", rolling: "Oct 2026" } },
  { id: "AT-02", raw: AT01, route: 10, expect: { tax: "Oct 2031", calendar: "Oct 2031", rolling: "Oct 2031" } },
  { id: "AT-03", raw: AT01, route: 3, expect: { tax: "Not reached", calendar: "Not reached", rolling: "Not reached" } },
  { id: "AT-04", raw: scenarioFor([["2024-02", 130000]], "2024-02"), route: 3,
    expect: { tax: "Apr 2027", calendar: "Jan 2028", rolling: "Feb 2027" } },
  { id: "AT-05", raw: scenarioFor([["2021-04", 40000], ["2023-09", 62000], ["2025-10", 40000]], "2021-04"), route: 5,
    expect: { tax: "Apr 2026", calendar: "Not reached", rolling: "Apr 2026" } },
  { id: "AT-06", raw: scenarioFor([["2020-01", 35000]], "2020-01"), route: 5,
    expect: { tax: "Not reached", calendar: "Not reached", rolling: "Not reached" } }
];

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const eq = (actual, expected, what = "") => {
  if (actual !== expected) throw new Error(`${what} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};
const ok = (cond, what) => { if (!cond) throw new Error(what); };

for (const at of acceptance) {
  for (const basis of BASES) {
    test(`${at.id} ${at.route}-year, ${basis}: ${at.expect[basis]}`, () => {
      const res = run(at.raw).results[at.route][basis];
      eq(short(res.earliest), at.expect[basis], "earliest");
    });
  }
}

// Notes under section 12
test("AT-01 note: rolling earnings test first met June 2026", () => {
  eq(short(run(AT01).results[5].rolling.earningsFirstMet), "Jun 2026");
});
test("AT-01 note: 2023/24 totals £49,500, £771 short", () => {
  const ev = run(AT01).results[5].tax;
  const tl = run(AT01).timeline;
  const at = evaluateAt(tl, 5, "tax", ev.earliest, RULES);
  const y = at.years.find((x) => x.label === "2023/24");
  eq(Math.round(y.total), 49500, "total");
  eq(y.shortBy, 771, "short by");
});
test("AT-01 explanation mentions the October raise", () => {
  const a = run(AT01);
  const res = a.results[5].tax;
  const lines = explain(a.timeline, res, evaluateAt(a.timeline, 5, "tax", res.earliest, RULES), RULES);
  ok(lines.some((l) => l.includes("2023/24 falls £771 short because the raise to £54,000 started in October 2023")), lines.join(" | "));
});
test("AT-04 note: calendar 2024 has 11 months (£119,167)", () => {
  const a = run(scenarioFor([["2024-02", 130000]], "2024-02"));
  const at = evaluateAt(a.timeline, 3, "calendar", parseMonth("2027-01"), RULES);
  const y = at.years.find((x) => x.label === "2024");
  eq(Math.round(y.total), 119167, "total");
  eq(y.pass, false, "pass");
});
test("AT-05 note: tax-year eligibility lapses from April 2029 (CE-04)", () => {
  const res = run(acceptance[4].raw).results[5].tax;
  eq(short(res.lapse), "Apr 2029");
  eq(short(res.windows[0].to), "Mar 2029", "window end");
});

// Additional checks
test("A £0 gap reduces the affected years", () => {
  const base = run(scenarioFor([["2021-04", 60000]], "2021-04"));
  const gap = run(scenarioFor([["2021-04", 60000], ["2022-07", 0], ["2022-10", 60000]], "2021-04"));
  const M = parseMonth("2026-04");
  const yb = evaluateAt(base.timeline, 5, "tax", M, RULES).years.find((y) => y.label === "2022/23");
  const yg = evaluateAt(gap.timeline, 5, "tax", M, RULES).years.find((y) => y.label === "2022/23");
  eq(Math.round(yb.total), 60000, "without gap");
  eq(Math.round(yg.total), 45000, "with 3-month gap");
  eq(yg.pass, false, "gap year fails");
});
test("A salary change in April moves the full amount into the new tax year", () => {
  const a = run(scenarioFor([["2021-04", 40000], ["2023-04", 60000]], "2021-04"));
  const years = evaluateAt(a.timeline, 5, "tax", parseMonth("2024-04"), RULES).years;
  eq(Math.round(years.find((y) => y.label === "2022/23").total), 40000, "2022/23");
  eq(Math.round(years.find((y) => y.label === "2023/24").total), 60000, "2023/24");
});
test("Invalid inputs block results and give messages", () => {
  const v = validate({
    routeStart: "2021-10",
    history: [{ from: "2021-06", salary: "45000" }, { from: "2022-01", salary: "-5" }, { from: "2022-01", salary: "50000" }, { from: "", salary: "" }],
    scenarios: { A: { mode: "keep" }, B: { mode: "projected", changes: [{ from: "2022-05", salary: "1" }] } }
  }, RULES, { asOf: AS_OF });
  eq(v.ok, false, "ok");
  eq(v.model, null, "model");
  ok(/before your route start/.test(v.errors["history.0.from"]), "before route start");
  ok(/negative/.test(v.errors["history.1.salary"]), "negative");
  ok(/Another salary period/.test(v.errors["history.2.from"]), "overlap");
  ok(v.errors["history.3.from"] && v.errors["history.3.salary"], "missing");
  ok(v.errors["scenarios.B.changes.0.from"], "projected change in the past");
});
test("Missing route start is reported", () => {
  const v = validate({ routeStart: "", history: [] }, RULES, { asOf: AS_OF });
  ok(v.errors.routeStart && v.errors.history, "both errors");
});

// Unit checks
test("Counted tax years before Nov 2026 end with 2025/26", () => {
  const ys = countedYears("tax", parseMonth("2026-11"), 2, RULES);
  eq(ys.map((y) => y.label).join(","), "2024/25,2025/26");
});
test("Rolling blocks count back from the month before application", () => {
  const ys = countedYears("rolling", parseMonth("2026-11"), 2, RULES);
  eq(ys.map((y) => y.label).join(","), "Nov 2024 – Oct 2025,Nov 2025 – Oct 2026");
});
test("Projected changes and growth", () => {
  const raw = scenarioFor([["2021-10", 45000]], "2021-10");
  raw.scenarios.B = { mode: "projected", changes: [{ from: "2027-03", salary: "60000" }], growthPct: "10" };
  const v = validate(raw, RULES, { asOf: AS_OF });
  ok(v.ok, JSON.stringify(v.errors));
  const tl = buildTimeline(v.model, "B", RULES, { asOf: AS_OF });
  const at = (s) => Math.round(tl.annual[parseMonth(s) - tl.start]);
  eq(at("2027-02"), 45000, "before change");
  eq(at("2027-03"), 60000, "change");
  eq(at("2028-02"), 60000, "before first growth");
  eq(at("2028-03"), 66000, "after one year of growth");
  const tlA = buildTimeline(v.model, "A", RULES, { asOf: AS_OF });
  eq(Math.round(tlA.annual[parseMonth("2030-01") - tlA.start]), 45000, "A keeps current salary");
});
test("Formatting", () => {
  eq(formatGBP(50271), "£50,271");
  eq(formatMonth(parseMonth("2026-06")), "June 2026");
  eq(formatDate(parseMonth("2027-04"), "tax", RULES), "6 April 2027");
  eq(formatDate(parseMonth("2027-04"), "rolling", RULES), "April 2027");
  eq(parseMonth("Oct 2021"), parseMonth("2021-10"));
  eq(parseMonth("10/2021"), parseMonth("2021-10"));
  eq(parseSalary("£54,000"), 54000);
  eq(parseSalary("54k"), 54000);
});
test("Share link round-trips, including non-ASCII labels", () => {
  const raw = { ...AT01, scenarios: { A: { label: "Café – stay", mode: "keep" }, B: { mode: "keep" } } };
  eq(JSON.stringify(decodeState(encodeState(raw))), JSON.stringify(raw));
  eq(decodeState("not-valid!!"), null);
});
test("CSV export has a row per route and basis", () => {
  const csv = toCSV([run(AT01)], { A: "Keep" }, RULES);
  eq(csv.trim().split("\n").length, 1 + 9, "rows");
  ok(csv.includes("Keep,5-year,Rolling 12 months,October 2026"), csv);
});
test("CE-06: one full scenario analysis takes under 100 ms", () => {
  const raw = scenarioFor([["2021-10", 45000], ["2023-10", 54000]], "2021-10");
  const t0 = (globalThis.performance || Date).now();
  for (let i = 0; i < 10; i++) run(raw, "A");
  const per = ((globalThis.performance || Date).now() - t0) / 10;
  ok(per < 100, `took ${per.toFixed(1)} ms`);
});

function runTests() {
  return tests.map(({ name, fn }) => {
    try { fn(); return { name, pass: true }; }
    catch (e) { return { name, pass: false, error: e.message }; }
  });
}

root.ILRTests = { runTests };

if (isNode && require.main === module) {
  const results = runTests();
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : `\n      ${r.error}`}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  if (typeof process !== "undefined") process.exitCode = failed ? 1 : 0;
}
})(typeof window !== "undefined" ? window : globalThis);

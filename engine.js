(function (root) {
"use strict";

// Pure calculation engine for the ILR earned settlement modeller.
// No DOM access: everything here takes plain data and returns plain data,
// so it can be unit tested in a browser or in Node.
//
// Months are represented internally as integers: year * 12 + (month - 1).
// A candidate application date is the first day of a month.

const BASES = ["tax", "calendar", "rolling"];
const BASIS_LABELS = {
  tax: "Tax year",
  calendar: "Calendar year",
  rolling: "Rolling 12 months"
};
const BASIS_NOUN = {
  tax: "tax-year",
  calendar: "calendar-year",
  rolling: "rolling 12-month"
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));

// ---------------------------------------------------------------------------
// Month helpers

function monthIndex(year, month) {
  return year * 12 + (month - 1);
}

function yearOf(idx) {
  return Math.floor(idx / 12);
}

function monthOf(idx) {
  return (((idx % 12) + 12) % 12) + 1;
}

/** Parse "2021-10", "10/2021", "Oct 2021" or "October 2021". Returns an index or null. */
function parseMonth(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
  if (m) return validYM(+m[1], +m[2]);
  m = s.match(/^(\d{1,2})\s*[/.-]\s*(\d{4})$/);
  if (m) return validYM(+m[2], +m[1]);
  m = s.match(/^([A-Za-z]+)\.?\s*,?\s*(\d{4})$/);
  if (m) {
    const name = m[1].toLowerCase();
    const i = MONTHS.findIndex((full) => full.toLowerCase().startsWith(name) && name.length >= 3);
    if (i >= 0) return validYM(+m[2], i + 1);
  }
  return null;
}

function validYM(y, mo) {
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12) return null;
  return monthIndex(y, mo);
}

/** Index to "YYYY-MM" (the value format of <input type="month">). */
function toMonthString(idx) {
  return `${yearOf(idx)}-${String(monthOf(idx)).padStart(2, "0")}`;
}

/** "October 2026" */
function formatMonth(idx) {
  return `${MONTHS[monthOf(idx) - 1]} ${yearOf(idx)}`;
}

/** "Oct 2026" */
function formatMonthShort(idx) {
  return `${MONTHS_SHORT[monthOf(idx) - 1]} ${yearOf(idx)}`;
}

/** Month name only, "October" */
function monthName(idx) {
  return MONTHS[monthOf(idx) - 1];
}

/** Date display for a basis. Tax-year dates that fall on the tax-year start are shown as "6 April 2027". */
function formatDate(idx, basis, rules) {
  if (basis === "tax" && monthOf(idx) === rules.taxYearStartMonth) {
    return `${rules.taxYearStartDay} ${formatMonth(idx)}`;
  }
  return formatMonth(idx);
}

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency", currency: "GBP", maximumFractionDigits: 0, minimumFractionDigits: 0
});

/** "£50,271" (rounded to the nearest pound) */
function formatGBP(n) {
  return GBP.format(Math.round(n));
}

/** Parse "54000", "£54,000" or "54k". Returns a number or null. */
function parseSalary(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined) return null;
  let s = String(value).trim().replace(/[£,\s]/g, "");
  if (!s) return null;
  let mult = 1;
  if (/k$/i.test(s)) { mult = 1000; s = s.slice(0, -1); }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s) * mult;
}

// ---------------------------------------------------------------------------
// Validation and normalisation

const MAX_SALARY = 10_000_000;

/**
 * Validate raw user input (strings straight from the form, or a saved scenario)
 * and, if valid, return a normalised model with month indexes and numbers.
 *
 * @returns {{ ok: boolean, errors: Object<string,string>, model: object|null }}
 */
function validate(raw, rules, { asOf } = {}) {
  const errors = {};
  const err = (path, msg) => { if (!errors[path]) errors[path] = msg; };

  const routeStart = parseMonth(raw?.routeStart);
  if (raw?.routeStart === undefined || raw?.routeStart === null || String(raw.routeStart).trim() === "") {
    err("routeStart", "Enter the month your route started.");
  } else if (routeStart === null) {
    err("routeStart", "Enter a month in the format YYYY-MM, for example 2021-10.");
  } else if (asOf !== undefined && routeStart > asOf) {
    err("routeStart", "The route start can't be in the future.");
  }

  const horizonEnd = routeStart === null ? null : routeStart + rules.horizonYears * 12;

  // Salary history
  const history = [];
  const rows = Array.isArray(raw?.history) ? raw.history : [];
  if (rows.length === 0) err("history", "Add at least one salary period.");
  const seen = new Map();
  rows.forEach((row, i) => {
    const from = parseMonth(row?.from);
    const salary = parseSalary(row?.salary);
    let rowOk = true;
    if (row?.from === undefined || row?.from === null || String(row.from).trim() === "") {
      err(`history.${i}.from`, "Enter the month this salary started."); rowOk = false;
    } else if (from === null) {
      err(`history.${i}.from`, "Enter a month in the format YYYY-MM."); rowOk = false;
    } else if (routeStart !== null && from < routeStart) {
      err(`history.${i}.from`, `This is before your route start (${formatMonth(routeStart)}).`); rowOk = false;
    } else if (asOf !== undefined && from > asOf) {
      err(`history.${i}.from`, "This date is in the future. Put future changes under “Your plan”."); rowOk = false;
    } else if (seen.has(from)) {
      err(`history.${i}.from`, `Another salary period also starts in ${formatMonth(from)}. Each month can only have one salary.`); rowOk = false;
    }
    if (row?.salary === undefined || row?.salary === null || String(row.salary).trim() === "") {
      err(`history.${i}.salary`, "Enter an annual salary. Use £0 for an unpaid gap."); rowOk = false;
    } else if (salary === null) {
      err(`history.${i}.salary`, "Enter the salary as a number of pounds, for example 45000."); rowOk = false;
    } else if (salary < 0) {
      err(`history.${i}.salary`, "The salary can't be negative."); rowOk = false;
    } else if (salary > MAX_SALARY) {
      err(`history.${i}.salary`, "That salary looks too large. Enter an annual figure in pounds."); rowOk = false;
    }
    if (from !== null && !seen.has(from)) seen.set(from, i);
    if (rowOk) history.push({ from, salary, row: i });
  });
  history.sort((a, b) => a.from - b.from);
  const lastHistoryFrom = history.length ? history[history.length - 1].from : null;

  // Scenarios
  const scenarios = {};
  for (const key of ["A", "B"]) {
    const s = raw?.scenarios?.[key] || { mode: "keep" };
    const mode = s.mode === "projected" ? "projected" : "keep";
    const out = { label: String(s.label || `Scenario ${key}`), mode, changes: [], growthPct: 0 };
    if (mode === "projected") {
      const seenC = new Set();
      (Array.isArray(s.changes) ? s.changes : []).forEach((c, i) => {
        const p = `scenarios.${key}.changes.${i}`;
        const from = parseMonth(c?.from);
        const salary = parseSalary(c?.salary);
        let ok = true;
        if (c?.from === undefined || c?.from === null || String(c.from).trim() === "") {
          err(`${p}.from`, "Enter the month this change starts."); ok = false;
        } else if (from === null) {
          err(`${p}.from`, "Enter a month in the format YYYY-MM."); ok = false;
        } else if (lastHistoryFrom !== null && from <= lastHistoryFrom) {
          err(`${p}.from`, `A projected change must start after your current salary (from ${formatMonth(lastHistoryFrom)}). Put past changes in your salary history.`); ok = false;
        } else if (asOf !== undefined && from < asOf) {
          err(`${p}.from`, "This date is in the past. Put past changes in your salary history."); ok = false;
        } else if (horizonEnd !== null && from >= horizonEnd) {
          err(`${p}.from`, `This is after the end of the ${rules.horizonYears}-year horizon (${formatMonth(horizonEnd)}).`); ok = false;
        } else if (seenC.has(from)) {
          err(`${p}.from`, `Another change also starts in ${formatMonth(from)}.`); ok = false;
        }
        if (c?.salary === undefined || c?.salary === null || String(c.salary).trim() === "") {
          err(`${p}.salary`, "Enter the new annual salary. Use £0 for an unpaid gap."); ok = false;
        } else if (salary === null) {
          err(`${p}.salary`, "Enter the salary as a number of pounds."); ok = false;
        } else if (salary < 0) {
          err(`${p}.salary`, "The salary can't be negative."); ok = false;
        } else if (salary > MAX_SALARY) {
          err(`${p}.salary`, "That salary looks too large. Enter an annual figure in pounds."); ok = false;
        }
        if (from !== null) seenC.add(from);
        if (ok) out.changes.push({ from, salary });
      });
      out.changes.sort((a, b) => a.from - b.from);
      const g = s.growthPct;
      if (g !== undefined && g !== null && String(g).trim() !== "") {
        const gn = Number(String(g).replace("%", "").trim());
        if (!Number.isFinite(gn)) err(`scenarios.${key}.growthPct`, "Enter a percentage, for example 3.");
        else if (gn < -20 || gn > 30) err(`scenarios.${key}.growthPct`, "Enter a yearly change between -20% and 30%.");
        else out.growthPct = gn;
      }
    }
    scenarios[key] = out;
  }

  // Application month
  let applyIn = null;
  if (raw?.applyIn !== undefined && raw?.applyIn !== null && String(raw.applyIn).trim() !== "") {
    applyIn = parseMonth(raw.applyIn);
    if (applyIn === null) err("applyIn", "Enter a month in the format YYYY-MM.");
    else if (routeStart !== null && applyIn <= routeStart) err("applyIn", "This must be after your route start.");
    else if (horizonEnd !== null && applyIn > horizonEnd) err("applyIn", `This is after the end of the ${rules.horizonYears}-year horizon (${formatMonth(horizonEnd)}).`);
  }

  const ok = Object.keys(errors).length === 0;
  return {
    ok,
    errors,
    model: ok ? { routeStart, history: history.map(({ from, salary }) => ({ from, salary })), scenarios, applyIn } : null
  };
}

// ---------------------------------------------------------------------------
// Earnings timeline

/**
 * Salary steps (annual salary in force from a month) for one scenario,
 * before growth is applied.
 */
function salarySteps(model, key) {
  const sc = model.scenarios[key];
  const steps = model.history.map((h) => ({ ...h, kind: "history" }));
  if (sc && sc.mode === "projected") {
    for (const c of sc.changes) steps.push({ ...c, kind: "projected" });
  }
  return steps.sort((a, b) => a.from - b.from);
}

/**
 * Build the month-by-month timeline for one scenario.
 * annual[i] is the annual salary in force in month (start + i).
 * Months before the route start, or before the first salary period, earn £0.
 */
function buildTimeline(model, key, rules, { asOf } = {}) {
  const start = model.routeStart;
  const end = start + rules.horizonYears * 12; // last candidate month; sums only use months before it
  const length = Math.max(end, model.applyIn ?? end) - start;
  const steps = salarySteps(model, key);
  const sc = model.scenarios[key];
  const growth = sc && sc.mode === "projected" ? (sc.growthPct || 0) / 100 : 0;
  const lastFrom = steps.length ? steps[steps.length - 1].from : start;
  const anchor = Math.max(lastFrom, asOf ?? lastFrom);

  const annual = new Float64Array(length);
  let s = -1;
  for (let i = 0; i < length; i++) {
    const idx = start + i;
    while (s + 1 < steps.length && steps[s + 1].from <= idx) s++;
    let value = s >= 0 ? steps[s].salary : 0;
    if (growth !== 0 && idx >= anchor + 12) {
      value = value * Math.pow(1 + growth, Math.floor((idx - anchor) / 12));
    }
    annual[i] = value;
  }
  const prefix = new Float64Array(length + 1);
  for (let i = 0; i < length; i++) prefix[i + 1] = prefix[i] + annual[i];
  return { key, start, end, length, annual, prefix, steps, growth, growthAnchor: anchor };
}

/** Earnings in months [a, b) (b exclusive). Months outside the timeline earn £0. */
function earnings(tl, a, b) {
  const lo = Math.min(Math.max(a - tl.start, 0), tl.length);
  const hi = Math.min(Math.max(b - tl.start, 0), tl.length);
  if (hi <= lo) return 0;
  return (tl.prefix[hi] - tl.prefix[lo]) / 12;
}

/** Annual salary in force in a month (0 before the route start). */
function salaryAt(tl, idx) {
  const i = idx - tl.start;
  if (i < 0 || i >= tl.length) return 0;
  return tl.annual[i];
}

// ---------------------------------------------------------------------------
// Counted years

function taxLabel(startIdx) {
  const y = yearOf(startIdx);
  return `${y}/${String((y + 1) % 100).padStart(2, "0")}`;
}

/**
 * The years counted for an application in month M, oldest first.
 * Each year is { start, end } with end exclusive, plus labels.
 */
function countedYears(basis, M, window, rules) {
  let latestEnd;
  if (basis === "rolling") {
    latestEnd = M;
  } else {
    const startMonth = basis === "tax" ? rules.taxYearStartMonth : 1;
    // The latest year boundary on or before M (a year ending at M finished the day before M).
    const offset = (monthOf(M) - startMonth + 12) % 12;
    latestEnd = M - offset;
  }
  const years = [];
  for (let k = window - 1; k >= 0; k--) {
    const end = latestEnd - 12 * k;
    const start = end - 12;
    let label, shortLabel;
    if (basis === "tax") {
      label = taxLabel(start);
      shortLabel = label.slice(2);
    } else if (basis === "calendar") {
      label = String(yearOf(start));
      shortLabel = label;
    } else {
      label = `${formatMonthShort(start)} – ${formatMonthShort(end - 1)}`;
      shortLabel = `${MONTHS_SHORT[monthOf(start) - 1]} ${String(yearOf(start)).slice(2)}`;
    }
    years.push({ start, end, label, shortLabel });
  }
  return years;
}

// ---------------------------------------------------------------------------
// Evaluation

/** Evaluate one route and basis at application month M. */
function evaluateAt(tl, routeKey, basis, M, rules) {
  const route = rules.routes[routeKey];
  // Compare on annual-salary sums (x12) to avoid floating point drift at the threshold.
  const thresholdX12 = route.threshold * 12;
  const years = countedYears(basis, M, route.window, rules).map((y) => {
    const lo = Math.min(Math.max(y.start - tl.start, 0), tl.length);
    const hi = Math.min(Math.max(y.end - tl.start, 0), tl.length);
    const sumX12 = hi > lo ? tl.prefix[hi] - tl.prefix[lo] : 0;
    const pass = sumX12 >= thresholdX12 - 1e-6;
    const total = sumX12 / 12;
    return {
      ...y,
      total,
      pass,
      shortBy: pass ? 0 : Math.max(1, Math.ceil(route.threshold - total - 1e-9)),
      monthsBeforeStart: Math.max(0, Math.min(12, tl.start - y.start))
    };
  });
  const passCount = years.filter((y) => y.pass).length;
  const firstCandidate = tl.start + Number(routeKey) * 12;
  const timeOk = M >= firstCandidate;
  const earningsOk = passCount >= route.need;
  return {
    route: Number(routeKey), basis, month: M, years, passCount,
    need: route.need, window: route.window, threshold: route.threshold,
    timeOk, earningsOk, eligible: timeOk && earningsOk, firstCandidate
  };
}

/**
 * Analyse one route and basis across the horizon: earliest month, qualifying
 * windows (CE-04), when the earnings test is first met, and the best pass count.
 */
function analyse(tl, routeKey, basis, rules) {
  const firstCandidate = tl.start + Number(routeKey) * 12;
  const end = tl.end;
  const windows = [];
  let current = null;
  let maxPassCount = 0;
  let earningsFirstMet = null;

  for (let M = tl.start + 1; M <= end; M++) {
    const ev = evaluateAt(tl, routeKey, basis, M, rules);
    if (ev.passCount > maxPassCount) maxPassCount = ev.passCount;
    if (ev.earningsOk && earningsFirstMet === null) earningsFirstMet = M;
    if (M < firstCandidate) continue;
    if (ev.eligible) {
      if (!current) { current = { from: M, to: null }; windows.push(current); }
    } else if (current) {
      current.to = M - 1;
      current = null;
    }
  }

  const reached = firstCandidate <= end && windows.length > 0;
  const earliest = reached ? windows[0].from : null;
  const lapse = reached && windows[0].to !== null ? windows[0].to + 1 : null;
  const detailMonth = earliest ?? Math.min(firstCandidate, end);
  return {
    route: Number(routeKey), basis, firstCandidate, earliest, lapse, windows,
    earningsFirstMet, maxPassCount, horizonEnd: end, detailMonth,
    need: rules.routes[routeKey].need, window: rules.routes[routeKey].window,
    threshold: rules.routes[routeKey].threshold
  };
}

/** Run every route under every basis for one scenario. */
function analyseScenario(model, key, rules, { asOf } = {}) {
  const tl = buildTimeline(model, key, rules, { asOf });
  const results = {};
  for (const r of Object.keys(rules.routes)) {
    results[r] = {};
    for (const b of BASES) results[r][b] = analyse(tl, r, b, rules);
  }
  let applyCheck = null;
  if (model.applyIn !== null && model.applyIn !== undefined) {
    applyCheck = {};
    for (const r of Object.keys(rules.routes)) {
      applyCheck[r] = {};
      for (const b of BASES) applyCheck[r][b] = evaluateAt(tl, r, b, model.applyIn, rules);
    }
  }
  return { key, timeline: tl, results, applyCheck, headline: headline(results, rules) };
}

// ---------------------------------------------------------------------------
// Headline and explanations

/** Overall earliest date, plus the earliest under each basis. */
function headline(results, rules) {
  const best = { tax: null, calendar: null, rolling: null };
  let overall = null;
  for (const r of Object.keys(rules.routes).map(Number).sort((a, b) => a - b)) {
    for (const b of BASES) {
      const res = results[r][b];
      if (res.earliest === null) continue;
      if (!best[b] || res.earliest < best[b].earliest) best[b] = res;
      if (!overall || res.earliest < overall.earliest) overall = res;
    }
  }
  return { overall, byBasis: best };
}

/** Human description of salary changes within months [a, b). */
function changesWithin(tl, a, b) {
  const out = [];
  for (let idx = Math.max(a + 1, tl.start + 1); idx < b; idx++) {
    const prev = salaryAt(tl, idx - 1);
    const next = salaryAt(tl, idx);
    if (Math.abs(next - prev) < 0.005) continue;
    let text;
    if (next === 0) text = `an unpaid gap started in ${formatMonth(idx)}`;
    else if (prev === 0) text = `pay of ${formatGBP(next)} started in ${formatMonth(idx)}`;
    else if (next > prev) text = `the raise to ${formatGBP(next)} started in ${formatMonth(idx)}`;
    else text = `pay fell to ${formatGBP(next)} in ${formatMonth(idx)}`;
    out.push(text);
  }
  return out;
}

function joinAnd(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Why a single counted year fell short. */
function explainYear(tl, year, threshold) {
  if (year.pass) return `${year.label} passes with ${formatGBP(year.total)}.`;
  const short = formatGBP(year.shortBy);
  if (year.monthsBeforeStart > 0) {
    const onRoute = 12 - year.monthsBeforeStart;
    if (onRoute <= 0) return `${year.label} falls ${short} short because it is before your route started.`;
    return `${year.label} falls ${short} short because only ${onRoute} month${onRoute === 1 ? "" : "s"} of it ${onRoute === 1 ? "is" : "are"} after your route start (${formatMonth(tl.start)}).`;
  }
  const changes = changesWithin(tl, year.start, year.end);
  if (changes.length) {
    const shown = changes.slice(0, 2);
    const more = changes.length > 2 ? ` (and ${changes.length - 2} other change${changes.length - 2 === 1 ? "" : "s"})` : "";
    return `${year.label} falls ${short} short because ${joinAnd(shown)}${more}.`;
  }
  const salary = salaryAt(tl, year.start);
  if (salary === 0) return `${year.label} falls ${short} short because no salary was earned.`;
  return `${year.label} falls ${short} short because the salary of ${formatGBP(salary)} is below the ${formatGBP(threshold)} threshold.`;
}

/**
 * Plain-English explanation for a route and basis (RV-05), as a list of sentences.
 * `ev` is the evaluation at the month being shown in the breakdown.
 */
function explain(tl, res, ev, rules) {
  const lines = [];
  const noun = BASIS_NOUN[res.basis];
  const yearsWord = res.basis === "rolling" ? "12-month blocks" : `${noun} years`;
  const fd = (m) => formatDate(m, res.basis, rules);

  lines.push(`At ${fd(ev.month)}, ${ev.passCount} of the ${ev.window} ${yearsWord} counted reach ${formatGBP(ev.threshold)}; ${ev.need} ${ev.need === 1 ? "is" : "are"} needed.`);

  if (res.earliest !== null) {
    if (res.earliest === res.firstCandidate) {
      if (res.earningsFirstMet !== null && res.earningsFirstMet < res.firstCandidate) {
        lines.push(`The earnings test is first met in ${fd(res.earningsFirstMet)}, but ${res.route} years on your route are not complete until ${fd(res.firstCandidate)}.`);
      } else {
        lines.push(`Both the earnings test and ${res.route} years on your route are first met in ${fd(res.earliest)}.`);
      }
    } else {
      const atFirst = evaluateAt(tl, res.route, res.basis, res.firstCandidate, rules);
      const finishing = atFirst.years.length && res.basis !== "rolling"
        ? countedYears(res.basis, res.earliest, res.window, rules).slice(-1)[0]
        : null;
      const once = finishing && finishing.end === res.earliest ? `, once ${finishing.label} has finished` : "";
      lines.push(`You complete ${res.route} years on your route in ${fd(res.firstCandidate)}, but then only ${atFirst.passCount} of the ${res.window} ${yearsWord} pass. The earnings test is met from ${fd(res.earliest)}${once}.`);
    }
    if (res.lapse !== null) {
      const atLapse = evaluateAt(tl, res.route, res.basis, res.lapse, rules);
      let text = `Eligibility lapses from ${fd(res.lapse)}: from then only ${atLapse.passCount} of the ${res.window} ${yearsWord} counted pass.`;
      if (res.windows.length > 1) text += ` It is met again from ${fd(res.windows[1].from)}.`;
      lines.push(text);
    }
  } else if (res.firstCandidate > res.horizonEnd) {
    lines.push(`${res.route} years on your route would end after the ${rules.horizonYears}-year horizon.`);
  } else if (res.maxPassCount === 0) {
    lines.push(`No ${res.basis === "rolling" ? "12-month block" : `${noun} year`} reaches ${formatGBP(res.threshold)} before ${formatMonth(res.horizonEnd)}, the end of the ${rules.horizonYears}-year horizon.`);
  } else {
    lines.push(`Before ${formatMonth(res.horizonEnd)}, the end of the ${rules.horizonYears}-year horizon, at most ${res.maxPassCount} of the ${res.window} ${yearsWord} pass at any one time.`);
  }

  for (const y of ev.years) if (!y.pass) lines.push(explainYear(tl, y, ev.threshold));
  return lines;
}

// ---------------------------------------------------------------------------
// Sharing and export

/** Results as CSV text (SP-04). */
function toCSV(analyses, labels, rules) {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [["Scenario", "Route", "Basis", "Earliest ILR", "Eligibility lapses", "Threshold", "Years needed"]];
  for (const a of analyses) {
    for (const r of Object.keys(rules.routes)) {
      for (const b of BASES) {
        const res = a.results[r][b];
        rows.push([
          labels[a.key] || a.key,
          `${r}-year`,
          BASIS_LABELS[b],
          res.earliest === null ? "Not reached" : formatDate(res.earliest, b, rules),
          res.lapse === null ? "" : formatDate(res.lapse, b, rules),
          rules.routes[r].threshold,
          `${rules.routes[r].need} of ${rules.routes[r].window}`
        ]);
      }
    }
  }
  return rows.map((r) => r.map(esc).join(",")).join("\n") + "\n";
}

/** Encode raw input as a URL-safe string (SP-03). */
function encodeState(raw) {
  const json = JSON.stringify(raw);
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode a string produced by encodeState. Returns null if it is not valid. */
function decodeState(str) {
  try {
    const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const obj = JSON.parse(new TextDecoder().decode(bytes));
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

const ILREngine = {
  BASES,
  BASIS_LABELS,
  BASIS_NOUN,
  monthIndex,
  yearOf,
  monthOf,
  parseMonth,
  toMonthString,
  formatMonth,
  formatMonthShort,
  monthName,
  formatDate,
  formatGBP,
  parseSalary,
  validate,
  salarySteps,
  buildTimeline,
  earnings,
  salaryAt,
  countedYears,
  evaluateAt,
  analyse,
  analyseScenario,
  headline,
  explainYear,
  explain,
  toCSV,
  encodeState,
  decodeState
};

if (typeof module === "object" && module.exports) module.exports = ILREngine;
else root.ILREngine = ILREngine;
})(typeof window !== "undefined" ? window : globalThis);

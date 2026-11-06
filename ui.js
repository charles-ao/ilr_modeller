// Form, rendering, SVG charts, storage and share links.
// All calculation lives in engine.js; this module only reads and writes the DOM.

(function () {
"use strict";

const RULES = window.ILR_RULES;
const {
  BASES, BASIS_LABELS, BASIS_NOUN, validate, analyseScenario, evaluateAt, explain,
  parseMonth, toMonthString, formatMonth, formatDate, formatGBP, parseSalary,
  monthIndex, yearOf, monthOf, encodeState, decodeState, toCSV,
  hmrcRows, taxYearOf, proRata, annualise
} = window.ILREngine;

const ROUTES = Object.keys(RULES.routes).map(Number).sort((a, b) => a - b);
const KEYS = ["A", "B"];
const DRAFT_KEY = "ilr-modeller:draft:v1";
const SAVED_KEY = "ilr-modeller:saved:v1";
const today = new Date();
const AS_OF = monthIndex(today.getFullYear(), today.getMonth() + 1);
const MONTH_INPUT = (() => {
  try { const i = document.createElement("input"); i.type = "month"; return i.type === "month"; }
  catch { return false; }
})();

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fd = (m, basis) => formatDate(m, basis, RULES);
// In HMRC mode, calendar and rolling results come from tax-year totals spread evenly, so they are estimates.
const isEst = (b) => ui.last?.model?.source === "hmrc" && b !== "tax";
const basisLabel = (b) => BASIS_LABELS[b] + (isEst(b) ? " (estimate)" : "");

// ---------------------------------------------------------------------------
// Storage (wrapped: private windows and blocked storage must not break the page)

const store = {
  available: (() => {
    try { const k = "ilr-modeller:test"; localStorage.setItem(k, "1"); localStorage.removeItem(k); return true; }
    catch { return false; }
  })(),
  get(key) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch { return null; } },
  set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch { return false; } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } }
};

// ---------------------------------------------------------------------------
// State

let uid = 0;
const newId = () => `r${++uid}`;
const blankScenarios = () => ({
  A: { label: "Keep current salary", mode: "keep", changes: [], bonuses: [], growthPct: "" },
  B: { label: "With projected changes", mode: "projected", changes: [], bonuses: [], growthPct: "" }
});
const blankHMRC = () => ({
  firstPart: "", firstFull: "", years: {}, ytd: "", ytdTo: "", currentSalary: "", currentSalaryAuto: true
});
const emptyState = () => ({
  version: 2, routeStart: "", source: "periods",
  history: [{ id: newId(), from: "", salary: "" }],
  hmrc: blankHMRC(),
  scenarios: blankScenarios(), applyIn: ""
});

const str = (v) => (v === null || v === undefined ? "" : String(v));
const monthStr = (v) => { const i = parseMonth(v); return i === null ? str(v) : toMonthString(i); };
const salaryStr = (v) => { const n = parseSalary(v); return n === null ? str(v) : n.toLocaleString("en-GB", { maximumFractionDigits: 2 }); };

/** Build editable state (strings with row ids) from saved or shared data. */
function fromRaw(obj) {
  const s = emptyState();
  if (!obj || typeof obj !== "object") return s;
  s.routeStart = monthStr(obj.routeStart);
  s.applyIn = monthStr(obj.applyIn);
  const hist = Array.isArray(obj.history) ? obj.history.slice(0, 120) : [];
  if (hist.length) s.history = hist.map((h) => ({ id: newId(), from: monthStr(h?.from), salary: salaryStr(h?.salary) }));
  s.source = obj.source === "hmrc" ? "hmrc" : "periods";
  const h = obj.hmrc && typeof obj.hmrc === "object" ? obj.hmrc : {};
  const years = {};
  for (const [ty, v] of Object.entries(h.years && typeof h.years === "object" ? h.years : {})) {
    if (/^\d{4}$/.test(ty)) years[ty] = salaryStr(v);
  }
  s.hmrc = {
    firstPart: salaryStr(h.firstPart), firstFull: salaryStr(h.firstFull), years,
    ytd: salaryStr(h.ytd), ytdTo: monthStr(h.ytdTo), currentSalary: salaryStr(h.currentSalary),
    currentSalaryAuto: h.currentSalaryAuto === undefined ? !str(h.currentSalary) : Boolean(h.currentSalaryAuto)
  };
  for (const k of KEYS) {
    const sc = obj.scenarios?.[k];
    if (!sc || typeof sc !== "object") continue;
    s.scenarios[k] = {
      label: str(sc.label).slice(0, 60) || s.scenarios[k].label,
      mode: sc.mode === "projected" ? "projected" : "keep",
      changes: (Array.isArray(sc.changes) ? sc.changes.slice(0, 120) : [])
        .map((c) => ({ id: newId(), from: monthStr(c?.from), salary: salaryStr(c?.salary) })),
      bonuses: (Array.isArray(sc.bonuses) ? sc.bonuses.slice(0, 120) : [])
        .map((b) => ({ id: newId(), month: monthStr(b?.month), amount: salaryStr(b?.amount) })),
      growthPct: sc.growthPct === 0 || sc.growthPct === "0" ? "" : str(sc.growthPct)
    };
  }
  sortRows(s.history);
  for (const k of KEYS) { sortRows(s.scenarios[k].changes); sortRows(s.scenarios[k].bonuses, "month"); }
  return s;
}

/** Plain data (section 8 data model) for validation, saving and sharing. */
function toRaw(s) {
  const num = (v) => { const n = parseSalary(v); return n === null ? v : n; };
  const scenarios = {};
  for (const k of KEYS) {
    const sc = s.scenarios[k];
    const g = String(sc.growthPct).trim();
    scenarios[k] = {
      label: sc.label, mode: sc.mode,
      changes: sc.changes.map((c) => ({ from: c.from, salary: num(c.salary) })),
      bonuses: sc.bonuses.map((b) => ({ month: b.month, amount: num(b.amount) })),
      growthPct: g === "" ? 0 : (Number.isFinite(Number(g)) ? Number(g) : g)
    };
  }
  const h = s.hmrc;
  return {
    version: 2, routeStart: s.routeStart, source: s.source,
    history: s.history.map((r) => ({ from: r.from, salary: num(r.salary) })),
    hmrc: {
      firstPart: num(h.firstPart), firstFull: num(h.firstFull),
      years: Object.fromEntries(Object.entries(h.years).map(([ty, v]) => [ty, num(v)])),
      ytd: num(h.ytd), ytdTo: h.ytdTo, currentSalary: num(h.currentSalary), currentSalaryAuto: h.currentSalaryAuto
    },
    scenarios, applyIn: s.applyIn || null
  };
}

/** Keep rows in date order; rows without a valid month stay at the end. */
function sortRows(arr, field = "from") {
  const key = (r) => { const i = parseMonth(r[field]); return i === null ? Infinity : i; };
  arr.sort((a, b) => key(a) - key(b));
  return arr;
}

const plus = (n) => toMonthString(AS_OF + n);
const PRESETS = {
  raise: () => ({
    routeStart: "2021-10",
    history: [{ from: "2021-10", salary: 45000 }, { from: "2023-10", salary: 54000 }],
    scenarios: {
      A: { label: "Stay put", mode: "keep" },
      B: { label: "New job at £60,000", mode: "projected", changes: [{ from: plus(4), salary: 60000 }], growthPct: 0 }
    }
  }),
  cut: () => ({
    routeStart: "2021-04",
    history: [{ from: "2021-04", salary: 40000 }, { from: "2023-09", salary: 62000 }, { from: "2025-10", salary: 40000 }],
    scenarios: {
      A: { label: "Stay on £40,000", mode: "keep" },
      B: { label: "Back to £55,000", mode: "projected", changes: [{ from: plus(3), salary: 55000 }], growthPct: 0 }
    }
  }),
  promotion: () => ({
    routeStart: "2022-06",
    history: [{ from: "2022-06", salary: 85000 }, { from: "2024-04", salary: 130000 }],
    scenarios: {
      A: { label: "Keep £130,000", mode: "keep" },
      B: { label: "Drop to £100,000", mode: "projected", changes: [{ from: plus(3), salary: 100000 }], growthPct: 0 }
    }
  }),
  steady: () => ({
    routeStart: "2022-01",
    history: [{ from: "2022-01", salary: 38000 }],
    scenarios: {
      A: { label: "Stay on £38,000", mode: "keep" },
      B: { label: "Promotion to £52,000", mode: "projected", changes: [{ from: plus(2), salary: 52000 }], growthPct: 0 }
    }
  }),
  // The mid-year raise example entered as HMRC figures, placed relative to the current tax year.
  hmrc: () => {
    const cty = taxYearOf(AS_OF, RULES);
    const years = { [cty - 4]: 45000, [cty - 3]: 49500, [cty - 2]: 54000, [cty - 1]: 54000 };
    const tyStart = monthIndex(cty, RULES.taxYearStartMonth);
    const done = AS_OF - tyStart; // complete months so far this tax year
    return {
      routeStart: toMonthString(monthIndex(cty - 5, 10)),
      source: "hmrc",
      hmrc: {
        firstPart: 22500, firstFull: 45000, years,
        ytd: done > 0 ? 4500 * done : "", ytdTo: done > 0 ? toMonthString(AS_OF - 1) : "",
        currentSalary: 54000, currentSalaryAuto: true
      },
      scenarios: {
        A: { label: "Stay put", mode: "keep" },
        B: { label: "New job at £60,000", mode: "projected", changes: [{ from: plus(4), salary: 60000 }], growthPct: 0 }
      }
    };
  }
};

let state = emptyState();
const ui = {
  active: "A",          // scenario being edited and shown
  selected: null,       // { route, basis } for the breakdown
  at: "earliest",       // breakdown month: "earliest" or "apply"
  touched: new Set(),   // fields the user has left, so their errors can show
  showAll: false,       // show every error (after loading saved or shared data)
  last: null,           // last valid analysis
  scroll: false,
  width: 0
};

// ---------------------------------------------------------------------------
// Form rendering

function monthAttrs() {
  return MONTH_INPUT ? 'type="month"' : 'type="text" inputmode="numeric" placeholder="YYYY-MM"';
}

function currentIndex() {
  let cur = -1;
  state.history.forEach((h, i) => { const m = parseMonth(h.from); if (m !== null && m <= AS_OF) cur = i; });
  return cur;
}

function rowMeta(row, isCurrent) {
  const parts = [];
  if (isCurrent) parts.push('<span class="badge badge-current">Current salary</span>');
  if (parseSalary(row.salary) === 0) parts.push('<span class="badge">Unpaid gap</span>');
  return parts.join("");
}

function rowHTML(kind, row, i, isCurrent) {
  const base = kind === "history" ? `history.${i}` : `scenarios.${ui.active}.changes.${i}`;
  const fid = `${row.id}-from`, sid = `${row.id}-salary`;
  const m = parseMonth(row.from);
  const what = m !== null ? formatMonth(m) : `row ${i + 1}`;
  return `<li class="row" data-id="${row.id}">
    <div class="row-meta">${rowMeta(row, isCurrent)}</div>
    <div class="field field-from">
      <label class="label" for="${fid}">${kind === "history" ? "From" : "Starts"}</label>
      <input class="input month" id="${fid}" ${monthAttrs()} value="${esc(row.from)}" data-path="${base}.from" data-touch="${row.id}.from" aria-describedby="${fid}-err">
    </div>
    <div class="field">
      <label class="label" for="${sid}">Annual salary</label>
      <div class="money"><span aria-hidden="true">£</span><input class="input" id="${sid}" inputmode="decimal" value="${esc(row.salary)}" data-path="${base}.salary" data-touch="${row.id}.salary" data-salary aria-describedby="${sid}-err"></div>
    </div>
    <button type="button" class="icon-btn" data-action="remove" data-kind="${kind}" data-id="${row.id}" aria-label="Remove ${kind === "history" ? "salary period" : "change"} from ${esc(what)}">✕</button>
    <div class="errors"><p class="field-error" id="${fid}-err" hidden></p><p class="field-error" id="${sid}-err" hidden></p></div>
  </li>`;
}

function bonusRowHTML(row, i) {
  const base = `scenarios.${ui.active}.bonuses.${i}`;
  const mid = `${row.id}-month`, aid = `${row.id}-amount`;
  const m = parseMonth(row.month);
  const what = m !== null ? formatMonth(m) : `row ${i + 1}`;
  return `<li class="row" data-id="${row.id}">
    <div class="row-meta"><span class="badge">One-off</span></div>
    <div class="field field-from">
      <label class="label" for="${mid}">Paid in</label>
      <input class="input month" id="${mid}" ${monthAttrs()} value="${esc(row.month)}" data-path="${base}.month" data-touch="${row.id}.month" aria-describedby="${mid}-err">
    </div>
    <div class="field">
      <label class="label" for="${aid}">Amount</label>
      <div class="money"><span aria-hidden="true">£</span><input class="input" id="${aid}" inputmode="decimal" value="${esc(row.amount)}" data-path="${base}.amount" data-touch="${row.id}.amount" data-salary aria-describedby="${aid}-err"></div>
    </div>
    <button type="button" class="icon-btn" data-action="remove" data-kind="bonus" data-id="${row.id}" aria-label="Remove one-off payment in ${esc(what)}">✕</button>
    <div class="errors"><p class="field-error" id="${mid}-err" hidden></p><p class="field-error" id="${aid}-err" hidden></p></div>
  </li>`;
}

function renderHistory() {
  const cur = currentIndex();
  $("#history-rows").innerHTML = state.history.map((r, i) => rowHTML("history", r, i, i === cur)).join("");
}

function renderPlanSwitch() {
  $("#plan-switch").innerHTML = KEYS.map((k) =>
    `<button type="button" data-action="scenario" data-key="${k}" aria-pressed="${ui.active === k}">${k}: ${esc(state.scenarios[k].label || `Scenario ${k}`)}</button>`
  ).join("");
}

function renderPlan() {
  const k = ui.active, sc = state.scenarios[k];
  const projected = sc.mode === "projected";
  $("#plan-editor").innerHTML = `
    <div class="field">
      <label class="label" for="sc-label">Name for scenario ${k}</label>
      <input class="input" id="sc-label" maxlength="60" value="${esc(sc.label)}" data-path="scenarios.${k}.label" data-touch="sc-${k}-label">
    </div>
    <fieldset class="radio-group">
      <legend class="label">From today</legend>
      <label class="radio"><input type="radio" name="mode" value="keep" ${projected ? "" : "checked"}> Keep my current salary</label>
      <label class="radio"><input type="radio" name="mode" value="projected" ${projected ? "checked" : ""}> Add projected changes</label>
    </fieldset>
    ${projected ? `
      <h4 class="hm-title">Salary changes</h4>
      <p class="help">Add each future pay rise, pay cut or unpaid gap, with the month it starts.</p>
      <ol class="rows" id="change-rows">${sc.changes.map((c, i) => rowHTML("change", c, i, false)).join("")}</ol>
      ${sc.changes.length ? "" : '<p class="help"><em>No changes yet. Your current salary carries on.</em></p>'}
      <div class="inline wrap-row">
        <button type="button" class="btn btn-secondary" data-action="add-change">+ Add change</button>
        <button type="button" class="btn btn-secondary" data-action="add-change-gap">+ Add gap</button>
      </div>
      <div class="plan-sub">
        <h4 class="hm-title">One-off payments <span class="optional">(optional)</span></h4>
        <p class="help">A bonus, commission or other one-off taxable payment, in the month it's paid. It counts in full in that month only, and doesn't change your salary.</p>
        <ol class="rows" id="bonus-rows">${sc.bonuses.map((b, i) => bonusRowHTML(b, i)).join("")}</ol>
        <button type="button" class="btn btn-secondary" data-action="add-bonus">+ Add one-off payment</button>
      </div>
      <div class="field">
        <label class="label" for="sc-growth">Yearly pay growth <span class="optional">(optional)</span></label>
        <p class="help" id="sc-growth-help">For example, 3 for 3% a year. Applied to your salary, not one-off payments, every 12 months after your last change, or after today if that's later.</p>
        <div class="inline"><input class="input" id="sc-growth" inputmode="decimal" style="max-width:8em" value="${esc(sc.growthPct)}" data-path="scenarios.${k}.growthPct" data-touch="sc-${k}-growth" aria-describedby="sc-growth-help sc-growth-err"><span>% a year</span></div>
        <p class="field-error" id="sc-growth-err" hidden></p>
      </div>`
    : `<p class="help">Your current salary is held flat to the end of the ${RULES.horizonYears}-year horizon.</p>`}`;
}

// ----- HMRC tax-year totals editor

const hmId = (path) => `hm-${path.slice(5).replace(/\./g, "-")}`;
let hmrcSig = null; // which tax-year rows are on screen, so they're only rebuilt when the route start changes

function currentHmrcRows() {
  const rs = parseMonth(state.routeStart);
  return rs !== null && rs <= AS_OF ? hmrcRows(rs, AS_OF, RULES) : null;
}

function moneyField(path, label, help, value) {
  const id = hmId(path);
  return `<div class="field">
    <label class="label" for="${id}">${label}</label>
    ${help ? `<p class="help" id="${id}-help">${help}</p>` : ""}
    <div class="money"><span aria-hidden="true">£</span><input class="input" id="${id}" inputmode="decimal" value="${esc(value)}" data-path="${path}" data-touch="${path}" data-salary aria-describedby="${help ? `${id}-help ` : ""}${id}-err"></div>
    <p class="field-error" id="${id}-err" hidden></p>
  </div>`;
}

function renderHMRC() {
  const box = $("#hmrc-editor");
  const rows = currentHmrcRows();
  hmrcSig = rows ? state.routeStart : "none";
  if (!rows) {
    box.innerHTML = '<p class="help hm-empty">Enter your route start in step 1. The tax years to fill in will then appear here.</p>';
    return;
  }
  const h = state.hmrc;
  const out = [];
  out.push(`<p class="help">Find these figures in your HMRC online account, under <a href="https://www.gov.uk/check-income-tax-last-years" rel="noopener" target="_blank">Check your Income Tax for previous years</a>, or on your P60s. Use taxable pay from employment, after salary sacrifice. If you had more than one job in a year, add them together.</p>`);

  if (rows.partYear) {
    const p = rows.partYear;
    out.push(`<div class="hm-block">
      <h4 class="hm-title">${p.label} <span class="optional">· part-year</span></h4>
      ${moneyField("hmrc.firstPart", `Taxable pay from ${formatMonth(p.start)} to 5 April ${p.ty + 1}`,
        `HMRC shows the whole of ${p.label}, but only your pay after your route start counts. Use your payslips for these ${p.months} month${p.months === 1 ? "" : "s"}.`, h.firstPart)}
      <details class="hm-helper"${h.firstFull ? " open" : ""}>
        <summary>Only have the full-year figure?</summary>
        ${moneyField("hmrc.firstFull", `HMRC total for the whole of ${p.label}`, "", h.firstFull)}
        <button type="button" class="btn btn-secondary btn-small" data-action="prorata">Estimate my part-year</button>
        <p class="help" id="hm-prorata-msg" aria-live="polite">This takes ${p.months} twelfths of the full-year total. That assumes you were paid evenly through the year, so use your real figure if you have it.</p>
      </details>
    </div>`);
  }

  if (rows.fullYears.length) {
    out.push(`<div class="hm-block"><h4 class="hm-title">Complete tax years</h4>
      ${rows.fullYears.map((y) => moneyField(`hmrc.years.${y.ty}`,
        `${y.label} <span class="optional">(6 April ${y.ty} to 5 April ${y.ty + 1})</span>`, "", h.years[y.ty] ?? "")).join("")}
    </div>`);
  }

  const c = rows.current;
  out.push(`<div class="hm-block">
    <h4 class="hm-title">${c.label} <span class="optional">· so far</span></h4>
    ${moneyField("hmrc.ytd", "Taxable pay so far this tax year",
      `Your year-to-date figure from your HMRC account or latest payslip${c.start > monthIndex(c.ty, RULES.taxYearStartMonth) ? `, counting from ${formatMonth(c.start)}` : ""}. Leave blank if you don't have one yet.`, h.ytd)}
    <div class="field">
      <label class="label" for="hm-ytdTo">The year to date runs to the end of</label>
      <input class="input month" id="hm-ytdTo" ${monthAttrs()} value="${esc(h.ytdTo)}" data-path="hmrc.ytdTo" data-touch="hmrc.ytdTo" aria-describedby="hm-ytdTo-err">
      <p class="field-error" id="hm-ytdTo-err" hidden></p>
    </div>
  </div>`);

  out.push(`<div class="hm-block">
    ${moneyField("hmrc.currentSalary", "Current annual salary",
      "Used from the end of your HMRC figures onwards, then your plan in step 3 takes over. We fill it in from your year-to-date figure. Change it if a bonus or pay rise makes the year to date unrepresentative.", h.currentSalary)}
  </div>`);

  out.push(`<p class="estimate-note"><strong>Calendar-year and rolling 12-month results will be estimates.</strong> HMRC gives one total for each tax year, so each total is spread evenly across its months. Tax-year results use your figures exactly.</p>`);
  box.innerHTML = out.join("");
}

/** Keep the current salary filled in from the year-to-date figure until the user types their own. */
function autoCurrentSalary() {
  const h = state.hmrc;
  if (state.source !== "hmrc" || !h.currentSalaryAuto) return;
  const rows = currentHmrcRows();
  if (!rows) return;
  const ytd = parseSalary(h.ytd), to = parseMonth(h.ytdTo);
  if (ytd === null || ytd < 0 || to === null || to < rows.current.start || to >= rows.current.end) return;
  const value = salaryStr(Math.round(annualise(ytd, rows.current.start, to)));
  if (value === h.currentSalary) return;
  h.currentSalary = value;
  const el = $("#hm-currentSalary");
  if (el && document.activeElement !== el) el.value = value;
}

function estimatePartYear() {
  const rows = currentHmrcRows();
  const msg = $("#hm-prorata-msg");
  if (!rows?.partYear) return;
  const full = parseSalary(state.hmrc.firstFull);
  if (full === null || full < 0) {
    msg.textContent = "Enter the full-year total first.";
    $("#hm-firstFull")?.focus();
    return;
  }
  const m = rows.partYear.months;
  const v = Math.round(proRata(full, m));
  state.hmrc.firstPart = salaryStr(v);
  $("#hm-firstPart").value = state.hmrc.firstPart;
  ui.touched.add("hmrc.firstPart");
  msg.textContent = `Estimated ${formatGBP(v)}: ${m} of 12 months of ${formatGBP(full)}. This assumes even pay through the year, so replace it with your real figure if you can.`;
  update();
}

function renderSource() {
  for (const r of $$('input[name="source"]')) r.checked = r.value === state.source;
  $("#periods-editor").hidden = state.source !== "periods";
  $("#hmrc-editor").hidden = state.source !== "hmrc";
  if (state.source === "hmrc") renderHMRC();
}

function renderForm() {
  $("#routeStart").value = state.routeStart;
  $("#applyIn").value = state.applyIn;
  renderHistory();
  renderSource();
  renderPlanSwitch();
  renderPlan();
}

function refreshMeta() {
  const cur = currentIndex();
  state.history.forEach((row, i) => {
    const el = $(`#history-rows .row[data-id="${row.id}"] .row-meta`);
    if (el) el.innerHTML = rowMeta(row, i === cur);
  });
  for (const row of state.scenarios[ui.active].changes) {
    const el = $(`#change-rows .row[data-id="${row.id}"] .row-meta`);
    if (el) el.innerHTML = rowMeta(row, false);
  }
}

// ---------------------------------------------------------------------------
// Paths: map validation paths to state, touch keys and element ids

function setByPath(path, value) {
  const p = path.split(".");
  if (p[0] === "routeStart" || p[0] === "applyIn") state[p[0]] = value;
  else if (p[0] === "history") { if (state.history[+p[1]]) state.history[+p[1]][p[2]] = value; }
  else if (p[0] === "scenarios") {
    const sc = state.scenarios[p[1]];
    if (p[2] === "changes" || p[2] === "bonuses") { if (sc[p[2]][+p[3]]) sc[p[2]][+p[3]][p[4]] = value; }
    else sc[p[2]] = value;
  } else if (p[0] === "hmrc") {
    if (p[1] === "years") state.hmrc.years[p[2]] = value;
    else {
      state.hmrc[p[1]] = value;
      if (p[1] === "currentSalary") state.hmrc.currentSalaryAuto = String(value).trim() === "";
    }
  }
}

function touchKey(path) {
  const p = path.split(".");
  if (p[0] === "history" && p.length === 3) return `${state.history[+p[1]]?.id}.${p[2]}`;
  if (p[0] === "scenarios" && (p[2] === "changes" || p[2] === "bonuses")) return `${state.scenarios[p[1]][p[2]][+p[3]]?.id}.${p[4]}`;
  if (p[0] === "scenarios" && p[2] === "growthPct") return `sc-${p[1]}-growth`;
  return path;
}

function elementId(path) {
  const p = path.split(".");
  if (p[0] === "history" && p.length === 3) return `${state.history[+p[1]]?.id}-${p[2]}`;
  if (p[0] === "history") return `${state.history[0]?.id}-from`;
  if (p[0] === "scenarios" && (p[2] === "changes" || p[2] === "bonuses")) return `${state.scenarios[p[1]][p[2]][+p[3]]?.id}-${p[4]}`;
  if (p[0] === "scenarios" && p[2] === "growthPct") return "sc-growth";
  if (p[0] === "hmrc") return hmId(path);
  return path;
}

function describePath(path) {
  const p = path.split(".");
  if (p[0] === "routeStart") return "Route start";
  if (p[0] === "hmrc") {
    if (p[1] === "firstPart") return "Part-year earnings";
    if (p[1] === "years") return `Tax year ${p[2]}/${String((+p[2] + 1) % 100).padStart(2, "0")}`;
    if (p[1] === "ytd") return "Year to date";
    if (p[1] === "ytdTo") return "Year to date, month";
    if (p[1] === "currentSalary") return "Current annual salary";
  }
  if (p[0] === "applyIn") return "Plan to apply in";
  if (p[0] === "history") return p.length === 3 ? `Salary history, row ${+p[1] + 1}` : "Salary history";
  if (p[0] === "scenarios" && p[2] === "changes") return `Scenario ${p[1]}, change ${+p[3] + 1}`;
  if (p[0] === "scenarios" && p[2] === "bonuses") return `Scenario ${p[1]}, one-off payment ${+p[3] + 1}`;
  if (p[0] === "scenarios") return `Scenario ${p[1]}, yearly growth`;
  return path;
}

function isVisible(path) {
  if (ui.showAll) return true;
  if (path === "history") return ui.touched.size > 0;
  return ui.touched.has(touchKey(path));
}

function showErrors(errors) {
  for (const el of $$("#form [data-path]")) {
    const msg = errors[el.dataset.path];
    const show = Boolean(msg) && isVisible(el.dataset.path);
    el.setAttribute("aria-invalid", show ? "true" : "false");
    const err = document.getElementById(`${el.id}-err`);
    if (err) { err.textContent = show ? msg : ""; err.hidden = !show; }
  }
  const h = $("#history-err");
  const showH = Boolean(errors.history) && isVisible("history");
  h.textContent = showH ? errors.history : "";
  h.hidden = !showH;
}

function goToField(path) {
  const p = path.split(".");
  if (p[0] === "scenarios" && p[1] !== ui.active) setActive(p[1]);
  const el = document.getElementById(elementId(path));
  if (el) { el.focus(); el.scrollIntoView({ block: "center", behavior: "smooth" }); }
}

// ---------------------------------------------------------------------------
// Update cycle

function update() {
  if (state.source === "hmrc") {
    const sig = currentHmrcRows() ? state.routeStart : "none";
    if (sig !== hmrcSig) renderHMRC();
    autoCurrentSalary();
  }
  const raw = toRaw(state);
  const v = validate(raw, RULES, { asOf: AS_OF });
  showErrors(v.errors);
  refreshMeta();
  store.set(DRAFT_KEY, { raw, active: ui.active });
  if (!v.ok) { ui.last = null; renderInvalid(v.errors); return; }
  ui.last = {
    model: v.model,
    A: analyseScenario(v.model, "A", RULES, { asOf: AS_OF }),
    B: analyseScenario(v.model, "B", RULES, { asOf: AS_OF })
  };
  renderResults();
}

function renderInvalid(errors) {
  const visible = Object.entries(errors).filter(([p]) => isVisible(p));
  const out = $("#results");
  if (!visible.length) {
    const hm = state.source === "hmrc";
    const empty = !state.routeStart && (hm || state.history.every((h) => !h.from && !h.salary));
    const todo = hm ? "Fill in each tax year and your current annual salary." : "Every salary row needs a month and an annual salary.";
    out.innerHTML = `<div class="placeholder"><p><strong>${empty ? "Your results will appear here." : "Complete your details to see results."}</strong></p>
      <p>${empty ? `Enter the month your route started and your ${hm ? "HMRC figures" : "salary history"}, or load an example.` : todo}</p></div>`;
    return;
  }
  out.innerHTML = `<div class="error-summary" aria-labelledby="err-sum-h">
    <h3 id="err-sum-h">Fix ${visible.length === 1 ? "this problem" : `these ${visible.length} problems`} to see your results</h3>
    <ul>${visible.map(([p, m]) => `<li><a href="#${esc(elementId(p))}" data-action="error-link" data-path="${esc(p)}">${esc(describePath(p))}: ${esc(m)}</a></li>`).join("")}</ul>
  </div>`;
}

// ---------------------------------------------------------------------------
// Results rendering

function defaultSelection(an) {
  const o = an.headline.overall;
  return o ? { route: o.route, basis: o.basis } : { route: 5, basis: "tax" };
}

function renderResults() {
  if (!ui.last) return;
  const { model } = ui.last;
  const an = ui.last[ui.active];
  if (ui.at === "apply" && model.applyIn === null) ui.at = "earliest";
  const sel = ui.selected || defaultSelection(an);
  const focusKey = document.activeElement?.dataset?.focusKey;
  const host = $("#results");
  ui.width = host.clientWidth;
  const inner = Math.max(280, ui.width - 16);

  host.innerHTML = [
    viewSwitchHTML(),
    headlineHTML(an),
    timelineHTML(an, model, sel, inner),
    gridHTML(an, sel),
    breakdownHTML(an, model, sel, Math.max(260, inner - 36)),
    model.applyIn !== null ? applyHTML(an, model, sel) : "",
    compareHTML(),
    printSummaryHTML(model)
  ].join("");

  if (focusKey) $(`[data-focus-key="${focusKey}"]`, host)?.focus({ preventScroll: true });
  if (ui.scroll) {
    ui.scroll = false;
    $("#breakdown", host)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function viewSwitchHTML() {
  return `<div class="view-switch">
    <span class="label" id="view-label">Showing</span>
    <div class="segmented" role="group" aria-labelledby="view-label">
      ${KEYS.map((k) => `<button type="button" data-action="view" data-key="${k}" data-focus-key="view-${k}" aria-pressed="${ui.active === k}">${k}: ${esc(state.scenarios[k].label || `Scenario ${k}`)}</button>`).join("")}
    </div>
  </div>`;
}

function headlineHTML(an) {
  const h = an.headline, o = h.overall;
  const label = esc(state.scenarios[ui.active].label || `Scenario ${ui.active}`);
  if (!o) {
    return `<div class="headline"><p class="caption">Scenario ${ui.active}: ${label}</p>
      <p class="headline-main">No route is reached within ${RULES.horizonYears} years of your route start, under any way of counting.</p>
      <p class="headline-sub">Select a route below to see which years fall short.</p></div>`;
  }
  const same = BASES.every((b) => h.byBasis[b] && h.byBasis[b].earliest === o.earliest && h.byBasis[b].route === o.route);
  let sub;
  if (same) {
    sub = "The same under all three ways of counting a year.";
  } else {
    sub = BASES.filter((b) => b !== o.basis).map((b) => {
      const r = h.byBasis[b];
      if (!r) return `Under a ${BASIS_NOUN[b]} basis: not reached.`;
      return `Under a ${BASIS_NOUN[b]} basis${isEst(b) ? " (estimate)" : ""}: <strong>${fd(r.earliest, b)}</strong>${r.route !== o.route ? ` (${r.route}-year route)` : ""}.`;
    }).join(" ");
  }
  return `<div class="headline" aria-live="polite">
    <p class="caption">Scenario ${ui.active}: ${label}</p>
    <p class="headline-main">Earliest ILR: <strong>${fd(o.earliest, o.basis)}</strong> (${o.route}-year route${same ? "" : `, ${BASIS_NOUN[o.basis]} basis${isEst(o.basis) ? ", estimate" : ""}`}).</p>
    ${ui.last.model.source === "hmrc" ? '<p class="caption">Calendar-year and rolling results are estimates, because your HMRC figures are tax-year totals.</p>' : ""}
    <p class="headline-sub">${sub}</p>
  </div>`;
}

// ----- Timeline (RV-03)

function timelineHTML(an, model, sel, width) {
  const tl = an.timeline, start = tl.start;
  let endM = start + 11 * 12;
  for (const r of ROUTES) for (const b of BASES) {
    const res = an.results[r][b];
    if (res.earliest !== null) endM = Math.max(endM, (res.lapse ?? res.earliest) + 12);
  }
  endM = Math.max(endM, AS_OF + 6, model.applyIn !== null ? model.applyIn + 6 : 0);
  endM = Math.min(endM, tl.end);
  const t0 = start - (monthOf(start) - 1);
  const t1 = Math.max(endM, t0 + 24);

  const L = 46, R = 12, axisH = 28, titleH = 22, trackH = 26, gap = 10, footH = 22;
  const laneH = titleH + ROUTES.length * trackH + gap;
  const H = axisH + BASES.length * laneH + footH;
  const plotW = width - L - R;
  const x = (m) => L + ((m - t0) / (t1 - t0)) * plotW;
  const bottom = axisH + BASES.length * laneH;

  // Year ticks
  const pxYear = (plotW * 12) / (t1 - t0);
  const step = pxYear >= 46 ? 1 : pxYear >= 24 ? 2 : 5;
  const ticks = [];
  for (let y = yearOf(t0); monthIndex(y, 1) <= t1; y++) {
    if ((y - yearOf(t0)) % step) continue;
    const xx = x(monthIndex(y, 1));
    const lbl = pxYear * step < 40 ? `’${String(y).slice(2)}` : String(y);
    ticks.push(`<line x1="${xx}" y1="${axisH - 6}" x2="${xx}" y2="${bottom}"/>`);
    ticks.push(`<text x="${xx}" y="${axisH - 10}" text-anchor="middle">${lbl}</text>`);
  }

  const parts = [];
  BASES.forEach((b, bi) => {
    const top = axisH + bi * laneH;
    parts.push(`<text class="tl-lane-title" x="0" y="${top + 15}">${basisLabel(b)}</text>`);
    ROUTES.forEach((r, ri) => {
      const ty = top + titleH + ri * trackH + trackH / 2;
      const res = an.results[r][b];
      parts.push(`<text class="tl-track-label" x="${L - 10}" y="${ty + 4}" text-anchor="end">${r}-yr</text>`);
      parts.push(`<line class="tl-track" x1="${x(start)}" y1="${ty}" x2="${x(t1)}" y2="${ty}"/>`);
      res.windows.forEach((w, wi) => {
        if (w.from > t1) return;
        const x1 = x(w.from), x2 = x(w.to === null ? t1 : Math.min(w.to + 1, t1));
        parts.push(`<rect class="${wi ? "tl-window-later" : "tl-window"}" x="${x1}" y="${ty - 4}" width="${Math.max(2, x2 - x1)}" height="8" rx="2"/>`);
        if (w.to !== null && w.to + 1 <= t1) parts.push(`<line class="tl-lapse" x1="${x2}" y1="${ty - 9}" x2="${x2}" y2="${ty + 9}"/>`);
      });
      if (res.earliest !== null && res.earliest <= t1) {
        const isSel = sel.route === r && sel.basis === b;
        const aria = `${r}-year route, ${basisLabel(b)}: earliest ${fd(res.earliest, b)}${res.lapse !== null ? `, lapses from ${fd(res.lapse, b)}` : ""}. Show breakdown.`;
        parts.push(`<g class="tl-marker${isSel ? " is-selected" : ""}" role="button" tabindex="0" aria-label="${esc(aria)}" data-action="select" data-route="${r}" data-basis="${b}" data-focus-key="m-${r}-${b}" transform="translate(${x(res.earliest)} ${ty})">
          <title>${esc(aria)}</title><circle class="ring" r="14"/><circle r="10"/><text text-anchor="middle" y="4">${r}</text></g>`);
      } else if (res.earliest === null) {
        parts.push(`<text class="tl-not" x="${x(start) + 6}" y="${ty - 6}">Not reached</text>`);
      }
    });
  });

  // Today and planned lines
  const lines = [];
  const marks = [];
  if (AS_OF >= t0 && AS_OF <= t1) marks.push({ m: AS_OF, cls: "tl-today", label: "Today" });
  if (model.applyIn !== null && model.applyIn >= t0 && model.applyIn <= t1) marks.push({ m: model.applyIn, cls: "tl-apply", label: "Planned" });
  marks.sort((a, b) => a.m - b.m);
  marks.forEach((mk, i) => {
    const xx = x(mk.m);
    lines.push(`<line class="${mk.cls}" x1="${xx}" y1="${axisH - 4}" x2="${xx}" y2="${bottom + 2}"/>`);
    let anchor = "middle";
    if (marks.length === 2 && Math.abs(x(marks[1].m) - x(marks[0].m)) < 70) anchor = i === 0 ? "end" : "start";
    if (xx > width - 30) anchor = "end";
    lines.push(`<text class="tl-today-label" x="${xx + (anchor === "start" ? 3 : anchor === "end" ? -3 : 0)}" y="${H - 6}" text-anchor="${anchor}">${mk.label}</text>`);
  });

  return `<div class="block">
    <div class="block-head"><h3>Timeline</h3><span class="caption">Select a marker to see the years behind it</span></div>
    <div class="timeline-wrap">
      <svg viewBox="0 0 ${width} ${H}" width="${width}" height="${H}" role="group" aria-label="Timeline from ${formatMonth(start)}: one lane for each way of counting a year, with a marker at each route's earliest ILR date. The same dates are in the table below.">
        <g class="tl-grid tl-axis">${ticks.join("")}</g>
        ${parts.join("")}
        ${lines.join("")}
      </svg>
    </div>
    <div class="legend" aria-hidden="true">
      <span><span class="sw sw-dot"></span>Earliest date (route years)</span>
      <span><span class="sw"></span>Eligible</span>
      <span><span class="sw sw-today"></span>Today</span>
      ${model.applyIn !== null ? '<span><span class="sw sw-apply"></span>Planned month</span>' : ""}
      <span>| Lapses</span>
    </div>
  </div>`;
}

// ----- Results grid (RV-02)

function gridHTML(an, sel) {
  const rows = ROUTES.map((r) => {
    const rule = RULES.routes[r];
    const dates = BASES.map((b) => an.results[r][b].earliest).filter((d) => d !== null);
    const best = dates.length ? Math.min(...dates) : null;
    const cells = BASES.map((b) => {
      const res = an.results[r][b];
      const isBest = res.earliest !== null && res.earliest === best;
      const isSel = sel.route === r && sel.basis === b;
      const cls = ["cell-btn", res.earliest === null ? "is-none" : "", isBest ? "is-best" : "", isSel ? "is-selected" : ""].join(" ");
      const date = res.earliest === null ? "Not reached" : fd(res.earliest, b);
      const lapse = res.lapse !== null ? `<span class="sub">Lapses from ${fd(res.lapse, b)}</span>` : "";
      const aria = `${r}-year route, ${basisLabel(b)}: ${date}${isBest ? ", earliest for this route" : ""}${res.lapse !== null ? `, lapses from ${fd(res.lapse, b)}` : ""}. Show breakdown.`;
      return `<td><button type="button" class="${cls}" data-action="select" data-route="${r}" data-basis="${b}" data-focus-key="c-${r}-${b}" aria-pressed="${isSel}" aria-label="${esc(aria)}">
        ${isBest ? '<span class="best-tag">Earliest</span>' : ""}<span class="date">${date}</span>${lapse}</button></td>`;
    }).join("");
    return `<tr><th scope="row">${r}-year route<span class="sub">${formatGBP(rule.threshold)} in ${rule.need} of ${rule.window} years</span></th>${cells}</tr>`;
  }).join("");
  return `<div class="block">
    <div class="block-head"><h3>Earliest date by route</h3><span class="caption">The earliest date for each route is highlighted</span></div>
    <div class="table-scroll">
      <table class="table grid">
        <caption class="sr-only">Earliest ILR date for each route (rows) under each way of counting a year (columns)</caption>
        <thead><tr><th scope="col">Route</th>${BASES.map((b) => `<th scope="col">${basisLabel(b)}</th>`).join("")}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

// ----- Breakdown (RV-04, RV-05)

const compact = (n) => {
  if (n >= 1_000_000) return `£${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  if (n >= 1000) return `£${(n / 1000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return formatGBP(n);
};

function barsSVG(ev, width) {
  const n = ev.years.length;
  const H = 230, L = 6, R = 6, top = 34, bottom = 30;
  const plotH = H - top - bottom;
  const maxV = Math.max(ev.threshold * 1.3, ...ev.years.map((y) => y.total)) * 1.08;
  const slot = (width - L - R) / n;
  const bw = Math.min(64, slot * 0.64);
  const y = (v) => top + plotH - (v / maxV) * plotH;
  const base = top + plotH;
  const out = [];
  const ty = y(ev.threshold);
  out.push(`<g class="bar-axis"><line x1="${L}" y1="${base}" x2="${width - R}" y2="${base}"/></g>`);
  out.push(`<line class="bar-threshold" x1="${L}" y1="${ty}" x2="${width - R}" y2="${ty}"/>`);
  ev.years.forEach((yr, i) => {
    const cx = L + slot * (i + 0.5);
    const yt = Math.min(y(yr.total), base - 3);
    out.push(`<rect class="${yr.pass ? "bar-pass" : "bar-fail"}" x="${cx - bw / 2}" y="${yt}" width="${bw}" height="${base - yt}" rx="2"/>`);
    out.push(`<text class="${yr.pass ? "bar-icon-pass" : "bar-icon-fail"}" x="${cx}" y="${yt - 6}" text-anchor="middle">${yr.pass ? "✓" : "✗"}${slot >= 62 ? ` ${compact(yr.total)}` : ""}</text>`);
    out.push(`<text class="bar-label" x="${cx}" y="${base + 18}" text-anchor="middle">${esc(yr.shortLabel)}</text>`);
  });
  out.push(`<line class="bar-threshold" x1="${L}" y1="12" x2="${L + 26}" y2="12"/><text class="bar-threshold-label" x="${L + 32}" y="16">${formatGBP(ev.threshold)} threshold</text>`);
  return `<svg viewBox="0 0 ${width} ${H}" width="${width}" height="${H}" role="img" aria-label="Bar chart of earnings in each year counted, against the ${formatGBP(ev.threshold)} threshold. The table below has the same figures.">${out.join("")}</svg>`;
}

function breakdownHTML(an, model, sel, width) {
  const res = an.results[sel.route][sel.basis];
  const useApply = ui.at === "apply" && model.applyIn !== null;
  const month = useApply ? model.applyIn : res.detailMonth;
  const ev = evaluateAt(an.timeline, sel.route, sel.basis, month, RULES);
  const lines = explain(an.timeline, res, ev, RULES);
  const b = sel.basis;

  let chip, note;
  if (useApply) {
    chip = ev.eligible ? `<span class="chip is-yes">✓ Met if you apply in ${fd(month, b)}</span>` : `<span class="chip">✗ Not met if you apply in ${fd(month, b)}</span>`;
    note = ev.timeOk ? "" : `<p>You'd have ${duration(month - an.timeline.start)} on your route by then; ${sel.route} years are needed.</p>`;
  } else if (res.earliest !== null) {
    chip = `<span class="chip is-yes">✓ Earliest: ${fd(res.earliest, b)}</span>`;
    note = `<p class="caption">Years counted for an application in ${fd(month, b)}.</p>`;
  } else {
    chip = `<span class="chip">✗ Not reached by ${formatMonth(res.horizonEnd)}</span>`;
    note = `<p class="caption">Years counted at ${fd(month, b)}, the first month with ${sel.route} years on your route.</p>`;
  }

  const switcher = model.applyIn !== null ? `<div class="segmented mini-switch" role="group" aria-label="Month to show">
      <button type="button" data-action="at" data-at="earliest" data-focus-key="at-earliest" aria-pressed="${!useApply}">At earliest date</button>
      <button type="button" data-action="at" data-at="apply" data-focus-key="at-apply" aria-pressed="${useApply}">At ${formatMonth(model.applyIn)}</button>
    </div>` : "";

  const rows = ev.years.slice().reverse().map((y) => `<tr>
      <th scope="row">${esc(y.label)}</th>
      <td class="num">${formatGBP(y.total)}</td>
      <td>${y.pass ? '<span class="pass">✓ Pass</span>' : `<span class="fail">✗ Short by ${formatGBP(y.shortBy)}</span>`}</td>
    </tr>`).join("");

  return `<div class="block breakdown" id="breakdown">
    <h3 id="breakdown-heading">${sel.route}-year route · ${basisLabel(b)}</h3>
    ${switcher}
    ${chip}
    ${note}
    <div class="bars">${barsSVG(ev, width)}</div>
    <div class="table-scroll">
      <table class="table">
        <caption class="sr-only">Earnings in each year counted, most recent first</caption>
        <thead><tr><th scope="col">${b === "rolling" ? "12 months" : "Year"}</th><th scope="col" class="num">Earned</th><th scope="col">Result (${formatGBP(ev.threshold)} needed)</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <ul class="explain">${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
  </div>`;
}

function duration(months) {
  const y = Math.floor(months / 12), m = months % 12;
  const parts = [];
  if (y) parts.push(`${y} year${y === 1 ? "" : "s"}`);
  if (m || !y) parts.push(`${m} month${m === 1 ? "" : "s"}`);
  return parts.join(" ");
}

// ----- Planned month check (RV-07)

function applyHTML(an, model, sel) {
  const rows = ROUTES.map((r) => {
    const cells = BASES.map((b) => {
      const ev = an.applyCheck[r][b];
      const reasons = [];
      if (!ev.timeOk) reasons.push(`only ${duration(model.applyIn - an.timeline.start)} on route`);
      if (!ev.earningsOk) reasons.push(`${ev.passCount} of ${ev.window} years pass, ${ev.need} needed`);
      const isSel = ui.at === "apply" && sel.route === r && sel.basis === b;
      const label = ev.eligible ? '<span class="pass">✓ Met</span>' : '<span class="fail">✗ Not met</span>';
      return `<td><button type="button" class="cell-btn${isSel ? " is-selected" : ""}" data-action="select-apply" data-route="${r}" data-basis="${b}" data-focus-key="a-${r}-${b}" aria-pressed="${isSel}">
        <span class="date">${label}</span>${reasons.length ? `<span class="sub">${reasons.join("; ")}</span>` : ""}</button></td>`;
    }).join("");
    return `<tr><th scope="row">${r}-year route</th>${cells}</tr>`;
  }).join("");
  return `<div class="block">
    <div class="block-head"><h3>If you apply in ${formatMonth(model.applyIn)}</h3></div>
    <div class="table-scroll">
      <table class="table grid">
        <caption class="sr-only">Whether each route is met for an application in ${formatMonth(model.applyIn)}</caption>
        <thead><tr><th scope="col">Route</th>${BASES.map((b) => `<th scope="col">${basisLabel(b)}</th>`).join("")}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

// ----- Scenario comparison (SP-01)

function spread(an, r) {
  const list = BASES.map((b) => ({ b, m: an.results[r][b].earliest })).filter((x) => x.m !== null);
  if (!list.length) return null;
  const best = list.reduce((a, c) => (c.m < a.m ? c : a));
  const worst = list.length === BASES.length ? list.reduce((a, c) => (c.m > a.m ? c : a)) : null;
  return { best, worst, missing: BASES.filter((b) => an.results[r][b].earliest === null) };
}

function compareHTML() {
  const { A, B } = ui.last;
  const notes = [];
  const rows = ROUTES.map((r) => {
    const cell = (an) => {
      const s = spread(an, r);
      if (!s) return '<td><span class="fail">✗ Not reached</span></td>';
      const tail = s.worst
        ? (s.worst.m === s.best.m ? "Same under all three" : `All three by ${fd(s.worst.m, s.worst.b)}`)
        : `Not reached on ${s.missing.map((b) => BASIS_NOUN[b]).join(" or ")} basis`;
      return `<td><strong>${fd(s.best.m, s.best.b)}</strong><span class="sub">${basisLabel(s.best.b)}</span><span class="sub">${tail}</span></td>`;
    };
    const sa = spread(A, r), sb = spread(B, r);
    if (sa && sb && sa.best.m !== sb.best.m) {
      const d = Math.abs(sa.best.m - sb.best.m);
      notes.push(`${sa.best.m < sb.best.m ? "A" : "B"} reaches the ${r}-year route ${duration(d)} sooner.`);
    } else if (sa && !sb) notes.push(`Only A reaches the ${r}-year route.`);
    else if (!sa && sb) notes.push(`Only B reaches the ${r}-year route.`);
    return `<tr><th scope="row">${r}-year route</th>${cell(A)}${cell(B)}</tr>`;
  }).join("");
  return `<div class="block">
    <div class="block-head"><h3>Compare scenarios</h3><span class="caption">Earliest date under any way of counting</span></div>
    <div class="table-scroll">
      <table class="table">
        <caption class="sr-only">Earliest ILR date for each route in scenario A and scenario B</caption>
        <thead><tr><th scope="col">Route</th><th scope="col">A: ${esc(state.scenarios.A.label)}</th><th scope="col">B: ${esc(state.scenarios.B.label)}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="compare-note">${notes.length ? esc(notes.join(" ")) : "Both scenarios give the same earliest dates."}</p>
  </div>`;
}

function printSummaryHTML(model) {
  const hist = model.source === "hmrc"
    ? model.segments.map((g) => `<li>${esc(g.label)}: ${formatGBP(g.total)} (HMRC figure)</li>`).join("") +
      `<li>From ${formatMonth(model.projStart)}: ${formatGBP(model.currentSalary)} a year</li>` +
      "<li>Calendar-year and rolling results are estimates based on these tax-year totals.</li>"
    : model.history.map((h) => `<li>From ${formatMonth(h.from)}: ${formatGBP(h.salary)} a year</li>`).join("");
  const plan = (k) => {
    const sc = model.scenarios[k];
    if (sc.mode === "keep") return "keep current salary";
    const ch = [
      ...sc.changes.map((c) => `${formatGBP(c.salary)} from ${formatMonth(c.from)}`),
      ...sc.bonuses.map((b) => `one-off ${formatGBP(b.amount)} in ${formatMonth(b.month)}`)
    ].join(", ") || "no changes";
    return `${ch}${sc.growthPct ? `; ${sc.growthPct}% a year growth` : ""}`;
  };
  return `<div class="print-only block">
    <h3>Your inputs</h3>
    <p>Route start: ${formatMonth(model.routeStart)}${model.applyIn !== null ? `. Planned application: ${formatMonth(model.applyIn)}` : ""}.</p>
    <ul>${hist}</ul>
    <p>Scenario A (${esc(state.scenarios.A.label)}): ${esc(plan("A"))}. Scenario B (${esc(state.scenarios.B.label)}): ${esc(plan("B"))}.</p>
    <p>Rules as announced in ${esc(RULES.source)}, last checked ${formatLongDate(RULES.lastChecked)}. Illustrative only, not immigration advice.</p>
  </div>`;
}

// ---------------------------------------------------------------------------
// Actions

function setActive(k) {
  if (!KEYS.includes(k) || k === ui.active) return;
  ui.active = k;
  renderPlanSwitch();
  renderPlan();
  update();
}

function announce(msg) {
  const el = $("#announce");
  if (el) { el.textContent = ""; setTimeout(() => { el.textContent = msg; }, 30); }
}

function status(msg) {
  const el = $("#status");
  el.textContent = msg;
  clearTimeout(status.t);
  status.t = setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 6000);
}

function loadState(raw, message) {
  state = fromRaw(raw);
  ui.selected = null;
  ui.at = "earliest";
  ui.touched.clear();
  ui.showAll = true;
  renderForm();
  update();
  if (message) status(message);
}

const rowsFor = (kind) => kind === "history" ? state.history
  : kind === "bonus" ? state.scenarios[ui.active].bonuses : state.scenarios[ui.active].changes;
const monthField = (kind) => (kind === "bonus" ? "month" : "from");

function scheduleResort(kind) {
  setTimeout(() => {
    const arr = rowsFor(kind);
    const before = arr.map((r) => r.id).join();
    sortRows(arr, monthField(kind));
    if (arr.map((r) => r.id).join() === before) return;
    const activeId = document.activeElement?.id;
    if (kind === "history") renderHistory(); else renderPlan();
    update();
    if (activeId) document.getElementById(activeId)?.focus();
  }, 0);
}

function addRow(kind, gap) {
  const row = kind === "bonus" ? { id: newId(), month: "", amount: "" } : { id: newId(), from: "", salary: gap ? "0" : "" };
  rowsFor(kind).push(row);
  if (kind === "history") renderHistory(); else renderPlan();
  update();
  document.getElementById(`${row.id}-${monthField(kind)}`)?.focus();
}

function removeRow(kind, id) {
  const arr = rowsFor(kind);
  const i = arr.findIndex((r) => r.id === id);
  if (i < 0) return;
  if (kind === "history" && arr.length === 1) { arr[0].from = ""; arr[0].salary = ""; }
  else arr.splice(i, 1);
  if (kind === "history") renderHistory(); else renderPlan();
  update();
  const next = arr[Math.min(i, arr.length - 1)];
  const addAction = { history: "add-history", change: "add-change", bonus: "add-bonus" }[kind];
  (next ? document.getElementById(`${next.id}-${monthField(kind)}`) : $(`[data-action="${addAction}"]`))?.focus();
}

function bindForm() {
  const form = $("#form");
  form.addEventListener("submit", (e) => e.preventDefault());

  form.addEventListener("input", (e) => {
    const el = e.target;
    if (!el.dataset.path) return;
    setByPath(el.dataset.path, el.value);
    if (el.dataset.path.endsWith(".label")) renderPlanSwitch();
    update();
  });

  form.addEventListener("change", (e) => {
    const el = e.target;
    if (el.name === "source") {
      state.source = el.value === "hmrc" ? "hmrc" : "periods";
      // Switching to HMRC: start the current salary from the salary history, if there is one.
      if (state.source === "hmrc" && !state.hmrc.currentSalary) {
        const cur = state.history[currentIndex()];
        if (cur && parseSalary(cur.salary) !== null) state.hmrc.currentSalary = cur.salary;
      }
      renderSource();
      update();
      return;
    }
    if (el.name === "mode") {
      state.scenarios[ui.active].mode = el.value;
      renderPlan();
      update();
      $(`input[name="mode"][value="${el.value}"]`)?.focus();
      return;
    }
    if (!el.dataset.path) return;
    if (!MONTH_INPUT && el.classList.contains("month")) {
      const m = parseMonth(el.value);
      if (m !== null) { el.value = toMonthString(m); setByPath(el.dataset.path, el.value); }
    }
    if (el.hasAttribute("data-salary")) {
      const n = parseSalary(el.value);
      if (n !== null && n >= 0) { el.value = salaryStr(n); setByPath(el.dataset.path, el.value); }
    }
    ui.touched.add(el.dataset.touch);
    if (el.dataset.path.endsWith(".from")) scheduleResort(el.dataset.path.startsWith("history") ? "history" : "change");
    if (/\.bonuses\.\d+\.month$/.test(el.dataset.path)) scheduleResort("bonus");
    update();
  });

  form.addEventListener("focusout", (e) => {
    const el = e.target;
    if (!el.dataset?.touch || ui.touched.has(el.dataset.touch)) return;
    if (el.value === "" && !ui.touched.size) return; // don't nag before anything is entered
    ui.touched.add(el.dataset.touch);
    update();
  });

  form.addEventListener("click", (e) => {
    const t = e.target.closest("[data-action]");
    if (!t) return;
    switch (t.dataset.action) {
      case "add-history": addRow("history", false); break;
      case "add-gap": addRow("history", true); break;
      case "add-change": addRow("change", false); break;
      case "add-change-gap": addRow("change", true); break;
      case "add-bonus": addRow("bonus", false); break;
      case "remove": removeRow(t.dataset.kind, t.dataset.id); break;
      case "prorata": estimatePartYear(); break;
      case "scenario": setActive(t.dataset.key); $(`#plan-switch [data-key="${t.dataset.key}"]`)?.focus(); break;
    }
  });
}

function bindResults() {
  const host = $("#results");
  host.addEventListener("click", (e) => {
    const t = e.target.closest("[data-action]");
    if (!t) return;
    const a = t.dataset.action;
    if (a === "error-link") { e.preventDefault(); goToField(t.dataset.path); return; }
    if (a === "view") { setActive(t.dataset.key); return; }
    if (a === "select" || a === "select-apply") {
      ui.selected = { route: Number(t.dataset.route), basis: t.dataset.basis };
      ui.at = a === "select-apply" ? "apply" : "earliest";
      ui.scroll = true;
      renderResults();
      announce(`Showing the breakdown for the ${t.dataset.route}-year route, ${basisLabel(t.dataset.basis)}.`);
      return;
    }
    if (a === "at") { ui.at = t.dataset.at; renderResults(); }
  });
  host.addEventListener("keydown", (e) => {
    const t = e.target.closest?.('g[role="button"]');
    if (!t || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    t.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  if ("ResizeObserver" in window) {
    let raf = 0;
    new ResizeObserver(() => {
      if (Math.abs(host.clientWidth - ui.width) < 4) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(renderResults);
    }).observe(host);
  }
}

function renderSaved() {
  const list = $("#saved-list");
  if (!store.available) {
    list.innerHTML = '<li><span class="help">Saving isn’t available in this browser, for example in a private window. Use “Copy link” instead.</span></li>';
    $("#save-btn").disabled = true;
    return;
  }
  const saved = store.get(SAVED_KEY) || {};
  const names = Object.keys(saved).sort((a, b) => (saved[b].savedAt || 0) - (saved[a].savedAt || 0));
  list.innerHTML = names.map((n) => `<li><span>${esc(n)}</span>
      <button type="button" class="btn btn-secondary btn-small" data-load="${esc(n)}">Load</button>
      <button type="button" class="btn btn-quiet btn-small" data-delete="${esc(n)}" aria-label="Delete ${esc(n)}">Delete</button></li>`).join("");
}

function bindActions() {
  $("#load-preset").addEventListener("click", () => {
    const key = $("#preset").value;
    if (!PRESETS[key]) { status("Choose an example first."); $("#preset").focus(); return; }
    if (state.routeStart && !confirm("Replace your current details with this example?")) return;
    loadState(PRESETS[key](), `Loaded the “${$("#preset").selectedOptions[0].text}” example.`);
  });

  $("#save-btn").addEventListener("click", () => {
    const input = $("#save-name");
    const name = input.value.trim() || `Saved ${new Date().toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}`;
    const saved = store.get(SAVED_KEY) || {};
    if (saved[name] && !confirm(`Replace the saved scenario “${name}”?`)) return;
    saved[name] = { raw: toRaw(state), savedAt: Date.now() };
    if (store.set(SAVED_KEY, saved)) { input.value = ""; renderSaved(); status(`Saved “${name}” in this browser.`); }
    else status("Couldn’t save. Your browser storage may be full or blocked.");
  });

  $("#saved-list").addEventListener("click", (e) => {
    const load = e.target.closest("[data-load]");
    const del = e.target.closest("[data-delete]");
    const saved = store.get(SAVED_KEY) || {};
    if (load && saved[load.dataset.load]) loadState(saved[load.dataset.load].raw, `Loaded “${load.dataset.load}”.`);
    if (del && confirm(`Delete the saved scenario “${del.dataset.delete}”?`)) {
      delete saved[del.dataset.delete];
      store.set(SAVED_KEY, saved);
      renderSaved();
      status("Deleted.");
      $("#save-name").focus();
    }
  });

  $("#copy-link").addEventListener("click", async () => {
    const url = `${location.href.split("#")[0]}#s=${encodeState(toRaw(state))}`;
    try { history.replaceState(null, "", url); } catch { /* ignore */ }
    try {
      await navigator.clipboard.writeText(url);
      status("Link copied. Anyone with the link can see these figures.");
    } catch {
      window.prompt("Copy this link:", url);
    }
  });

  $("#export-csv").addEventListener("click", () => {
    if (!ui.last) { status("Fix your details first, then export."); return; }
    const csv = toCSV([ui.last.A, ui.last.B], { A: `A: ${state.scenarios.A.label}`, B: `B: ${state.scenarios.B.label}` }, RULES);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "ilr-earned-settlement-results.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    status("CSV downloaded.");
  });

  $("#print-btn").addEventListener("click", () => window.print());

  $("#clear-all").addEventListener("click", () => {
    if (!confirm("Clear all your details and delete every saved scenario from this browser? This can’t be undone.")) return;
    store.remove(DRAFT_KEY);
    store.remove(SAVED_KEY);
    try { history.replaceState(null, "", location.pathname + location.search); } catch { /* ignore */ }
    state = emptyState();
    Object.assign(ui, { active: "A", selected: null, at: "earliest", showAll: false });
    ui.touched.clear();
    $("#preset").value = "";
    renderForm();
    renderSaved();
    update();
    status("Cleared. Saved scenarios have been deleted.");
    $("#routeStart").focus();
  });

  window.addEventListener("hashchange", () => {
    const raw = readHash();
    if (raw) loadState(raw, "Loaded the scenario from the link.");
  });
}

function readHash() {
  const m = location.hash.match(/^#s=([A-Za-z0-9_-]+)$/);
  return m ? decodeState(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Static content from config (CG-04)

function formatLongDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? `${Number(m[3])} ${formatMonth(monthIndex(+m[1], +m[2]))}` : String(iso || "");
}

function fillConfig() {
  const values = {
    source: esc(RULES.source),
    lastChecked: formatLongDate(RULES.lastChecked),
    horizon: String(RULES.horizonYears),
    household: formatGBP(RULES.householdThreshold ?? 25142)
  };
  for (const el of $$("[data-config]")) el.innerHTML = values[el.dataset.config] ?? "";
  $("#sources").innerHTML = RULES.sources.map((s) => `<li><a href="${esc(s.url)}" rel="noopener" target="_blank">${esc(s.label)}</a></li>`).join("");
  $("#rules-table").innerHTML = ROUTES.map((r) => {
    const x = RULES.routes[r];
    return `<tr><th scope="row">${r}-year</th><td>${formatGBP(x.threshold)}</td><td>${x.need} of the ${x.window} years before applying</td><td>${esc(x.band || "")}</td></tr>`;
  }).join("");
  for (const id of ["routeStart", "applyIn"]) {
    const el = $(`#${id}`);
    if (MONTH_INPUT) el.type = "month";
    else { el.type = "text"; el.inputMode = "numeric"; el.placeholder = "YYYY-MM"; }
  }
  $("#routeStart").max = toMonthString(AS_OF);
}

// ---------------------------------------------------------------------------
// Start

function init() {
  const live = document.createElement("p");
  live.id = "announce";
  live.className = "sr-only";
  live.setAttribute("aria-live", "polite");
  $("#results").after(live);

  fillConfig();
  const shared = readHash();
  const draft = store.get(DRAFT_KEY);
  if (shared) {
    state = fromRaw(shared);
    ui.showAll = true;
  } else if (draft?.raw) {
    state = fromRaw(draft.raw);
    ui.active = draft.active === "B" ? "B" : "A";
    ui.showAll = Boolean(state.routeStart);
  }
  renderForm();
  renderSaved();
  bindForm();
  bindResults();
  bindActions();
  update();
}

init();
})();

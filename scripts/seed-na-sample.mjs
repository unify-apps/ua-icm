#!/usr/bin/env node
// Seed a slice of the REAL NA Salesforce export as Transaction records, plus the org
// and plan the engine needs to credit it.
//
//   node scripts/seed-na-sample.mjs plan  [--env tool]
//   node scripts/seed-na-sample.mjs apply --env tool
//
// WHAT THE EXPORT ACTUALLY SAYS, measured across all 2,917 rows rather than assumed:
//
//   TOTAL CREDITS          == Amount + CHANNEL INVENTORY SPLIT     2917 / 2917
//   CHANNEL INVENTORY SPLIT == Channel Inventory Amount x Percent  2917 / 2917
//   Amount                 == (Total Amount - Channel Inv) x Pct   2793 / 2917
//
// The third only holds 96% of the time, and the misses are not noise: `Total Amount`
// is the OPPORTUNITY's value, and an opportunity can span several order numbers or be
// shipped in parts, so it is NOT a per-order base. The first two are exact, so THEY are
// the contract. `Amount` and `CHANNEL INVENTORY SPLIT` are the two credited figures, and
// both already have the split applied.
//
// SO ONE EXPORT ROW IS UP TO TWO COMMISSIONABLE LINES, not one: the direct value and the
// channel-inventory value. They are separate columns, they sum to TOTAL CREDITS, and the
// record type is literally called "Channel and Direct". Each becomes its own Transaction
// carrying `attrs.component`, and the base is recovered as Amount / Percent so the engine
// re-derives the split instead of trusting a pre-multiplied number.
//
// NAMES ARE REAL, EVERYTHING ELSE IS LOUD. Payee names must be real because resolving a
// name is the thing under test. Every employeeId, position, plan, rule and transaction id
// is TEST-NA- prefixed, the period is its own TEST-NA-JUL-2026, and every row carries
// batchId TEST-NA-JUL2026. Nothing here can be mistaken for payroll.

import fs from "node:fs";
import csvPath from "node:path";
import { resolveEnv } from "./env.mjs";

const die = (m) => { console.error(`error: ${m}`); process.exit(1); };
const { env, baseUrl, headers, args } = resolveEnv({ write: true });
const cmd = args[0];
if (cmd !== "plan" && cmd !== "apply") die("usage: seed-na-sample.mjs plan|apply [--env tool]");

const CSV = args[args.indexOf("--csv") + 1] && args.includes("--csv")
  ? args[args.indexOf("--csv") + 1]
  : "/Users/krish.sharma/Downloads/Sample_NA_SF_Data and Query - NA DATA.csv";
if (!fs.existsSync(CSV)) die(`no CSV at ${CSV}`);

// ------------------------------------------------------------------ csv + money
function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift().map((h) => h.replace(/^﻿/, "").trim());
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
}

/** "USD -4,365.59" -> -436559 minor units. Exact: string arithmetic, never a float. */
function cents(s) {
  const t = String(s ?? "").replace(/USD/gi, "").replace(/,/g, "").trim();
  if (!t) return null;
  const m = t.match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const frac = (m[3] ?? "").padEnd(2, "0");
  return Number(`${m[1]}${m[2]}${frac}`);
}
/** "70.00%" -> 7000 bps */
function bps(s) {
  const t = String(s ?? "").replace("%", "").trim();
  if (!t) return null;
  const [w, f = ""] = t.split(".");
  return Number(w) * 100 + Number((f + "00").slice(0, 2));
}
/** "7/22/2026" -> epoch millis at UTC midnight. M/D/YYYY - a bare 22 is never a month. */
function epoch(s) {
  const m = String(s ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
}

const rows = parseCsv(fs.readFileSync(CSV, "utf8"));

// ------------------------------------------------------- the orders, and why each
// Every order below is here to make one specific thing true or false. A sample that
// only contains the happy path proves the happy path and nothing else.
const ORDERS = {
  "00388125": "170% overlay - Jens 100% + Andrei 70% on ONE order. Splits must not be normalised.",
  "00391559": "170% overlay again, different reps and record type. Twice is not an accident.",
  "00392225": "200% overlay - 50% + 100% + 50%. The case the design doc flagged as unconfirmed.",
  "00387167": "Channel inventory, three rows, 50/50/100. Two credit components per row.",
  "00386893": "Channel inventory at scale - USD 47k of channel behind USD 13k of direct.",
  "00395661": "Billing Credit|Rebill, NEGATIVE USD -4,365.59. Must be credited, not dropped.",
  "00395650": "Billing Credit, NEGATIVE USD -268.82.",
  "00395966": "NEGATIVE on a Channel and Direct row, two team members.",
  "00384850": "Close 6/23, ship 7/22 - lands in July ONLY because ship date is the trigger.",
  "00377914": "Close 5/29, ship 7/21 - two months apart, same test.",
  "00387058": "USD 0.00. Zero is a real row, and it must not become a credit.",
  "00387319": "Nick Vera is deliberately NOT seeded -> UNRESOLVED_PAYEE beside a real credit.",
  "00387603": "Plain renewal, 100%, the ordinary case that must still be exactly right.",
  "00388112": "Plain renewal, different rep.",
  "00387030": "Plain renewal, different rep.",
};

// Reps that get a seat. Nick Vera is missing ON PURPOSE - see 00387319 above.
const SEATED = ["Rayan Abdoun", "Jens Lentfer", "Andrei Sin", "Sophia Maria Zimmermann",
  "Martin Dinangue Ndzana", "Stephen Wickens", "Anthony Vetro", "Matt Murray",
  "Lisa Leavitt", "Mike Iturreria", "Greger Gustafson", "Bobby Snader",
  "Alden Naeny", "Bert Goo", "Mike Vena", "Carlouie Salas", "Steffen Bittler", "Terry McPhee"];

const picked = rows.filter((r) => ORDERS[r["Order Number"]]);
if (!picked.length) die("no rows matched the chosen orders - has the CSV changed?");

// --------------------------------------------------------- row -> transaction(s)
const txns = [];
let seq = 0;
for (const r of picked) {
  const order = r["Order Number"];
  const name = r["Team Member: Full Name"];
  const split = bps(r["Percent (%)"]);
  const amount = cents(r["Amount (converted)"]);
  const chanSplit = cents(r["CHANNEL INVENTORY SPLIT"]);
  const chanAmt = cents(r["Channel Inventory Amount (converted)"]);
  const close = epoch(r["Close Date"]);
  const ship = epoch(r["Order Actual Ship Date"]);
  if (split == null || amount == null || close == null) continue;

  const base = {
    orderNumber: order, recordType: r["Opportunity Record Type"],
    opportunityName: r["Opportunity Name"], ownerName: r["Opportunity Owner: Full Name"],
    payeeName: name, splitBps: split, sfAmount: amount,
    sfChannelSplit: chanSplit, sfTotalCredits: cents(r["TOTAL CREDITS"]),
    sfTotalAmount: cents(r["Total Amount (converted)"]),
  };

  const line = (component, amtBase, expect) => {
    seq += 1;
    txns.push({
      transactionId: `TEST-NA-${order}-${String(seq).padStart(3, "0")}`,
      sourceId: order, sourceSystem: "TEST-NA-SF-EXPORT",
      // The trigger is the SHIP date: only shipped orders are commissionable, so that
      // is the date the deal belongs to. Close date is kept, never used to place it.
      closeDate: close, incentiveDate: ship ?? close,
      amount: amtBase, batchId: "TEST-NA-JUL2026",
      customer: r["Account Name: Account Name"] || r["Account Name"] || "",
      product: "", attrs: { ...base, component, expectedCredit: expect },
    });
  };

  // The base is recovered by DIVIDING OUT the split, because `Amount` already has it
  // applied. Feeding a pre-multiplied number to an engine that multiplies again is how
  // 70% silently becomes 49%.
  const directBase = Math.round((amount * 10000) / split);
  line("DIRECT", directBase, amount);
  if (chanAmt) line("CHANNEL_INV", chanAmt, chanSplit);
}

// ------------------------------------------------------------------- the platform
async function api(pathname, body) {
  const res = await fetch(baseUrl + pathname, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) die(`${pathname} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}
async function findBy(type, field, value) {
  const out = await api(`/api/entity/${type}`, {
    filter: { op: "AND", values: [{ field: `properties.${field}`, op: "EQUAL", values: [value] }] },
    page: { limit: 2, offset: 0 },
  });
  const got = out.response?.objects ?? out.objects ?? [];
  if (got.length > 1) die(`${type} ${field}=${value} matches ${got.length} rows`);
  return got[0]?.id ?? null;
}
const log = [];
async function ensure(type, key, properties) {
  const value = properties[key];
  const existing = await findBy(type, key, value);
  if (existing) { log.push(`  = ${type.padEnd(24)} ${value}`); return existing; }
  if (cmd === "plan") { log.push(`  + ${type.padEnd(24)} ${value}`); return `PLANNED-${value}`; }
  const out = await api("/api/entity/create-update-or-delete/hierarchical", { entity: { entityType: type, properties }, requestType: "CREATED" });
  const first = Array.isArray(out) ? out[0] : out;
  const id = first?.id;
  if (!id) die(`${type} ${value}: create returned no id`);
  log.push(`  + ${type.padEnd(24)} ${value}  -> ${id}`);
  return id;
}
const need = async (type, field, value) => (await findBy(type, field, value)) ?? die(`${type} ${field}=${value} not found`);

const USD   = await need("Currency", "code", "USD");
const T_AE  = await need("Title", "titleCode", "T-AE");
const T_RSM = await need("Title", "titleCode", "T-RSM");
const T_VP  = await need("Title", "titleCode", "T-VP");
const EMEA  = await need("Territory", "territoryCode", "TR-EMEA");

const JUL01 = Date.UTC(2026, 6, 1), JUL31 = Date.UTC(2026, 6, 31), JAN01 = Date.UTC(2026, 0, 1);

// A period of its own, so this run cannot pick up anybody else's rows and nobody else's
// run can pick up these. It deliberately overlaps the real JUL-2026, which is CLOSED.
await ensure("Period", "name", { name: "TEST-NA-JUL-2026", periodType: "MONTH", startDate: JUL01, endDate: JUL31, status: "OPEN" });
await ensure("CreditType", "creditTypeCode", { creditTypeCode: "CHANNEL_INV", name: "Channel Inventory", active: true,
  description: "The channel-inventory half of a Channel and Direct row. Its own type because it is a different column, a different base, and almost certainly a different rate." });

const slug = (n) => n.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
const seatOf = {};
const makeSeat = async (personName, code, titleId, empSuffix) => {
  const payee = await ensure("Payee", "employeeId", {
    employeeId: `TEST-NA-${empSuffix}`, name: personName,
    email: `${slug(personName).toLowerCase()}@example.invalid`,
    currencyId: USD, hireDate: JAN01, status: "ACTIVE",
  });
  const pos = await ensure("Position", "positionCode", { positionCode: code, name: `TEST-NA ${personName}`, active: true });
  await ensure("PositionAttribute", "name", { name: `${code} attrs`, positionId: pos, titleId, territoryId: EMEA, effectiveStart: JAN01 });
  await ensure("PayeePositionAssignment", "name", { name: `${personName} holds ${code}`, payeeId: payee, positionId: pos, effectiveStart: JAN01, allocationPct: 100 });
  seatOf[personName] = pos;
  return pos;
};

const VP  = await makeSeat("TEST-NA VP Sales", "TEST-NA-VP-01", T_VP, "VP01");
const RSM = await makeSeat("TEST-NA Regional Manager", "TEST-NA-RSM-01", T_RSM, "RSM01");
await ensure("PositionHierarchy", "name", { name: "TEST-NA-RSM-01 -> TEST-NA-VP-01", positionId: RSM, parentPositionId: VP, effectiveStart: JAN01 });

let n = 0;
for (const person of SEATED) {
  n += 1;
  const code = `TEST-NA-AE-${String(n).padStart(2, "0")}`;
  const pos = await makeSeat(person, code, T_AE, `E${String(9100 + n)}`);
  await ensure("PositionHierarchy", "name", { name: `${code} -> TEST-NA-RSM-01`, positionId: pos, parentPositionId: RSM, effectiveStart: JAN01 });
}

// ------------------------------------------------------------------- rules + plan
// None of the three sets splitBps: the ROW's own Percent stands, which is the whole
// point of carrying it as a fact.
const RULES = [
  { ruleId: "TEST-NA-CR-RENEWAL", name: "TEST NA - Renewal direct credit",
    description: "The direct half of a Renewals row. Rolls one level so the manager's number is built from the same credits, under a DIFFERENT type - with the same type, attainment double-counts.",
    conditions: { items: [
      { connector: "If", subject: "txn.attrs.component", operator: "==", value: "DIRECT" },
      { connector: "And", subject: "txn.attrs.recordType", operator: "==", value: "Renewals" }] },
    result: { name: "TEST NA - Renewal direct credit", rollable: true,
      values: { creditType: "RENEWAL", rollup: "true", rollupLevels: "1", rollupCreditType: "MGR_ROLLUP" } } },

  { ruleId: "TEST-NA-CR-DIRECT", name: "TEST NA - New business direct credit",
    description: "The direct half of everything that is not a renewal. `in` splits on commas, so the three record types are one condition rather than three rules.",
    conditions: { items: [
      { connector: "If", subject: "txn.attrs.component", operator: "==", value: "DIRECT" },
      { connector: "And", subject: "txn.attrs.recordType", operator: "in", value: "Channel and Direct, NA Direct, NA Channel" }] },
    result: { name: "TEST NA - New business direct credit", rollable: false,
      values: { creditType: "NEW_BOOKING", rollup: "false" } } },

  { ruleId: "TEST-NA-CR-CHANNEL", name: "TEST NA - Channel inventory credit",
    description: "The channel-inventory half. Its own credit type because it is a different base and a different economics - folding it into NEW_BOOKING would hide it inside attainment.",
    conditions: { items: [
      { connector: "If", subject: "txn.attrs.component", operator: "==", value: "CHANNEL_INV" }] },
    result: { name: "TEST NA - Channel inventory credit", rollable: false,
      values: { creditType: "CHANNEL_INV", rollup: "false" } } },
];
for (const r of RULES) {
  await ensure("Rule", "ruleId", { ...r, stage: "credit", ruleType: "Direct Credit",
    activeStart: JUL01, activeEnd: JUL31, rollableOnReporting: !!r.result.values.rollup });
}

const plan = await ensure("Plan", "planId", {
  planId: "TEST-NA-PLAN-01", name: "TEST NA July 2026 plan (safe to delete)",
  description: "Assigned to the T-AE title, so every seeded rep picks it up without eighteen separate seat assignments.",
  version: 1, periodId: "TEST-NA-JUL-2026", status: "Active", startDate: JUL01, endDate: JUL31,
  creditRules: RULES.map((r) => r.ruleId), payoutRules: [],
});
await ensure("PlanAssignment", "assignmentId", {
  assignmentId: "TEST-NA-PLAN-01-Title-T-AE", planId: plan,
  targetType: "Title", targetId: T_AE, titleId: T_AE, startDate: JUL01, endDate: JUL31,
});

for (const t of txns) await ensure("Transaction", "transactionId", { ...t, currencyId: USD });

// ------------------------------------------------------------------------ report
console.log(`${cmd === "plan" ? "PLAN" : "APPLIED"} on ${env}`);
console.log(log.join("\n"));
const created = log.filter((l) => l.startsWith("  +")).length;
console.log(`\n${created} to create, ${log.length - created} already present`);
console.log(`export rows selected: ${picked.length} across ${Object.keys(ORDERS).length} orders -> ${txns.length} transactions`);
const direct = txns.filter((t) => t.attrs.component === "DIRECT");
const chan = txns.filter((t) => t.attrs.component === "CHANNEL_INV");
const sum = (a) => a.reduce((s, t) => s + t.attrs.expectedCredit, 0);
console.log(`  DIRECT      ${String(direct.length).padStart(3)}   expected credit total ${(sum(direct) / 100).toFixed(2)}`);
console.log(`  CHANNEL_INV ${String(chan.length).padStart(3)}   expected credit total ${(sum(chan) / 100).toFixed(2)}`);

#!/usr/bin/env node
// Seed the ICM | Calculate Credits test bed. Read records/calculate-credits-testbed.json
// for what each row proves - this file is the mechanism, that one is the reasoning.
//
//   node scripts/seed-calculate-credits.mjs plan   [--env tool]
//   node scripts/seed-calculate-credits.mjs apply  --env tool
//
// IDEMPOTENT BY BUSINESS KEY. Every row is looked up by the key in the records file
// before it is written, so a second run creates nothing. That matters more than it
// sounds: the platform DERIVES uniqueKeyFields from per-field flags and discards a
// composite, so "unique on A + B" is never enforced by the database - re-running a
// seeder that does not check is how a test bed doubles every number it was built to
// verify.
//
// This is a SEEDER, not fixtures.mjs: it writes named TEST- rows on tool and never
// deletes. Removal is by hand, which is the safe direction on production.

import fs from "node:fs";
import path from "node:path";
import { resolveEnv, ROOT } from "./env.mjs";

const die = (m) => { console.error(`error: ${m}`); process.exit(1); };
const { env, baseUrl, headers, args } = resolveEnv({ write: true });
const cmd = args[0];
if (cmd !== "plan" && cmd !== "apply") die("usage: seed-calculate-credits.mjs plan|apply [--env tool]");

const spec = JSON.parse(fs.readFileSync(path.join(ROOT, "records", "calculate-credits-testbed.json"), "utf8"));
const KEY = spec.keyField;

async function api(pathname, body) {
  const res = await fetch(baseUrl + pathname, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) die(`${pathname} -> HTTP ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

/** Find one record by its business key. Returns the id, or null. */
async function findByKey(type, value) {
  const field = KEY[type] ?? die(`no keyField for ${type}`);
  const out = await api(`/api/entity/${type}`, {
    filter: { op: "AND", values: [{ field: `properties.${field}`, op: "EQUAL", values: [value] }] },
    page: { limit: 2, offset: 0 },
  });
  const rows = out.response?.objects ?? out.objects ?? [];
  if (rows.length > 1) die(`${type} ${field}=${value} matches ${rows.length} rows - resolve by hand before seeding`);
  return rows[0]?.id ?? null;
}

const made = [];
async function ensure(type, properties) {
  const value = properties[KEY[type]];
  const existing = await findByKey(type, value);
  if (existing) { made.push(`  = ${type.padEnd(24)} ${value}  (exists)`); return existing; }
  if (cmd === "plan") { made.push(`  + ${type.padEnd(24)} ${value}`); return `PLANNED:${type}:${value}`; }
  const out = await api("/api/entity/create-update-or-delete/hierarchical", {
    entity: { entityType: type, properties }, requestType: "CREATED",
  });
  // The hierarchical writer answers with an ARRAY of the entities it touched, not the
  // single object the endpoint's own docs imply. Reading `out.id` finds undefined on a
  // write that fully succeeded.
  const first = Array.isArray(out) ? out[0] : out;
  const id = first?.id ?? first?.entity?.id ?? first?.response?.id;
  if (!id) die(`${type} ${value}: create returned no id - ${JSON.stringify(out).slice(0, 300)}`);
  made.push(`  + ${type.padEnd(24)} ${value}  -> ${id}`);
  return id;
}

// ---------------------------------------------------------------- existing ids
// Resolved rather than pasted: an id typed into a script is an id that silently
// matches nothing the day somebody rebuilds the reference data.
const need = async (type, field, value) => {
  const out = await api(`/api/entity/${type}`, {
    filter: { op: "AND", values: [{ field: `properties.${field}`, op: "EQUAL", values: [value] }] }, page: { limit: 2 },
  });
  const rows = out.response?.objects ?? out.objects ?? [];
  if (rows.length !== 1) die(`${type} ${field}=${value} matched ${rows.length} rows, expected exactly 1`);
  return rows[0].id;
};

const USD    = await need("Currency", "code", "USD");
const T_AE   = await need("Title", "titleCode", "T-AE");
const T_RSM  = await need("Title", "titleCode", "T-RSM");
const T_VP   = await need("Title", "titleCode", "T-VP");
const EMEA   = await need("Territory", "territoryCode", "TR-EMEA");

const JAN1 = 1767225600000;          // 2026-01-01, before every window this bed uses
const SEP11 = 1789084800000;         // inside SEP-2026
const JUN01 = 1780272000000;         // outside it, on purpose
const SEP01 = 1788220800000, SEP30 = 1790726400000;

// ------------------------------------------------------------------- the people
const payee = async (employeeId, name) => ensure("Payee", {
  employeeId, name, email: `${employeeId.toLowerCase()}@example.invalid`,
  currencyId: USD, hireDate: JAN1, status: "ACTIVE",
});
const ANDREI = await payee("TEST-E-9001", "TEST-Andrei Sib");
const JENS   = await payee("TEST-E-9002", "TEST-Jens Lentfer");
const RAYAN  = await payee("TEST-E-9003", "TEST-Rayan Abdoun");
const DIANE  = await payee("TEST-E-9004", "TEST-Diane Vega");
await payee("TEST-E-9005", "TEST-Sophia Zimmermann");       // deliberately seatless

// -------------------------------------------------------------------- the seats
const seat = async (code, name) => ensure("Position", { positionCode: code, name, active: true });
const AE1 = await seat("TEST-POS-AE-01", "TEST AE seat - title plan lane");
const AE2 = await seat("TEST-POS-AE-02", "TEST AE seat - seat plan wins");
const RSM = await seat("TEST-POS-RSM-01", "TEST RSM seat - manager");
const VP  = await seat("TEST-POS-VP-01", "TEST VP seat - grandparent");

const attr = (name, positionId, titleId, territoryId) =>
  ensure("PositionAttribute", { name, positionId, titleId, territoryId, effectiveStart: JAN1 });
await attr("TEST-POS-AE-01 attrs", AE1, T_AE, EMEA);
await attr("TEST-POS-AE-02 attrs", AE2, T_AE, EMEA);
await attr("TEST-POS-RSM-01 attrs", RSM, T_RSM, EMEA);
await attr("TEST-POS-VP-01 attrs", VP, T_VP, EMEA);

const holds = (name, payeeId, positionId) =>
  ensure("PayeePositionAssignment", { name, payeeId, positionId, effectiveStart: JAN1, allocationPct: 100 });
await holds("TEST-Andrei Sib holds TEST-POS-AE-01", ANDREI, AE1);
await holds("TEST-Jens Lentfer holds TEST-POS-AE-02", JENS, AE2);
await holds("TEST-Rayan Abdoun holds TEST-POS-RSM-01", RAYAN, RSM);
await holds("TEST-Diane Vega holds TEST-POS-VP-01", DIANE, VP);

const reports = (name, positionId, parentPositionId) =>
  ensure("PositionHierarchy", { name, positionId, parentPositionId, effectiveStart: JAN1 });
await reports("TEST-POS-AE-01 -> TEST-POS-RSM-01", AE1, RSM);
await reports("TEST-POS-AE-02 -> TEST-POS-RSM-01", AE2, RSM);
await reports("TEST-POS-RSM-01 -> TEST-POS-VP-01", RSM, VP);

// ------------------------------------------------------- the seat-lane plan
// No splitBps on the result: the ROW's own split stands, which is what makes C03
// prove that the source percentage is read at all.
await ensure("Rule", {
  ruleId: "TEST-CR-SEAT-01", stage: "credit", ruleType: "Direct Credit",
  name: "TEST Seat-assigned renewal credit (safe to delete)",
  description: "Reached only through a plan assigned to the SEAT. Files under RENEWAL so the credit itself says which lane won.",
  activeStart: SEP01, activeEnd: SEP30, rollableOnReporting: false,
  // An ordered list in a `json` column MUST be wrapped: a bare array saves with a 200
  // and reads back as {}, and a rule whose conditions vanished matches every deal.
  conditions: { items: [{ connector: "If", subject: "position.title", operator: "==", value: "T-AE" }] },
  result: { name: "TEST Seat-assigned renewal credit", rollable: false,
            values: { creditType: "RENEWAL", rollup: "false" } },
});
const PLAN_SEAT = await ensure("Plan", {
  planId: "TEST-PLAN-SEAT-01", name: "TEST Seat plan (safe to delete)",
  description: "Assigned to TEST-POS-AE-02 by SEAT. Exists to prove the seat lane beats the title lane on a seat that carries both.",
  version: 1, periodId: "SEP-2026", status: "Active", startDate: SEP01, endDate: SEP30,
  creditRules: ["TEST-CR-SEAT-01"], payoutRules: [],
});
await ensure("PlanAssignment", {
  assignmentId: "TEST-PLAN-SEAT-01-Position-TEST-POS-AE-02", planId: PLAN_SEAT,
  targetType: "Position", targetId: AE2, positionId: AE2, startDate: SEP01, endDate: SEP30,
});

// --------------------------------------------------------------- the deals
const txn = (n, order, payeeName, amount, splitBps, when, extra = {}) => ensure("Transaction", {
  transactionId: `TEST-TXN-${n}`, sourceId: order, sourceSystem: "TEST-SALESFORCE-EXPORT",
  closeDate: when, incentiveDate: when, amount, currencyId: USD, batchId: "TEST-CC-01",
  product: "CLOUD", customer: extra.customer ?? "TEST Account",
  attrs: { payeeName, splitBps, orderNumber: order, recordType: extra.recordType ?? "Renewals",
           opportunityName: extra.opportunityName ?? "", sfSplitAmount: extra.sfSplitAmount ?? null },
});

await txn("C01", "00388125", "TEST-Jens Lentfer", 593484, 10000, SEP11,
  { opportunityName: "Renewal - DB Schenker - 12Token", customer: "DSV Road Spain SAU", sfSplitAmount: 593484 });
await txn("C02", "00388125", "TEST-Andrei Sib", 593484, 7000, SEP11,
  { opportunityName: "Renewal - DB Schenker - 12Token", customer: "DSV Road Spain SAU", sfSplitAmount: 415439 });
await txn("C03", "00392225", "TEST-Jens Lentfer", 250000, 7000, SEP11,
  { opportunityName: "Renewals - GLAXO OPERATIONS UK LTD-Q2", customer: "MITIE Technical Facilities Management Ltd", sfSplitAmount: 175000 });
await txn("C04", "00395650", "TEST-Jens Lentfer", -26882, 10000, SEP11,
  { opportunityName: "Billing Credit | Amendment bopla | CPCLD-DATA-ren", recordType: "Billing Credit", customer: "bopla", sfSplitAmount: -26882 });
await txn("C05", "00384850", "TEST-Andrei Sib", 336344, 10000, JUN01,
  { opportunityName: "Renewals-NEO Natural Energy Organisation GmbH", customer: "Gady Auto Moto GmbH", sfSplitAmount: 336344 });
await txn("C06", "00393630", "TEST-Sophia Zimmermann", 2577778, 10000, SEP11,
  { opportunityName: "Credit/Rebill Renewals - SoftCat PLC", customer: "Softcat PLC", sfSplitAmount: 2577778 });
await txn("C07", "00399001", "Nicholas Sib", 100000, 10000, SEP11,
  { opportunityName: "TEST unresolved payee name", customer: "TEST Account" });
await txn("C08", "00399002", "TEST-Rayan Abdoun", 500000, 10000, SEP11,
  { opportunityName: "TEST manager seat with no plan", customer: "TEST Account" });

console.log(`${cmd === "plan" ? "PLAN" : "APPLIED"} on ${env} (${baseUrl})`);
console.log(made.join("\n"));
const created = made.filter((l) => l.startsWith("  +")).length;
console.log(`${created} to create, ${made.length - created} already present`);
if (cmd === "plan") console.log(`re-run with: node scripts/seed-calculate-credits.mjs apply --env tool`);

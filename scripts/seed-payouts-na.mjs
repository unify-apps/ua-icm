#!/usr/bin/env node
// Seed the ICM | Calculate Payouts test bed on top of the NA credit run.
//
//   node scripts/seed-payouts-na.mjs plan  [--env tool]
//   node scripts/seed-payouts-na.mjs apply --env tool
//
// WHY ON THE NA RUN. TEST-NA-JUL-2026 already has a Succeeded, non-dry-run credit run
// (RUN-1789049445958-81a256, 39 credits) whose seats resolve to TEST-NA-PLAN-01. Paying it
// needs no new period, no new transactions and no new credit run - only payout config.
//
// WHAT EACH ROW PROVES (amounts in minor units, rates in bps):
//
//   TEST-NA-PR-FLAT      Flat rate 500 bps on RENEWAL credits - one Earning per credit.
//   TEST-NA-PR-TIER-NB   Tiered on NEW_BOOKING, the PAYEE's quota (Quota on their seat):
//        seat ..91d6  9,833,027 / 10,000,000  = 9,833 bps  -> tier 2 (500)  -> 491,651
//        seat ..91e4 19,666,053 / 10,000,000  = 19,666 bps -> above top, tier 3 (800) -> 1,573,284
//        seat ..91ee  9,833,027 / 19,666,054  = 5,000 bps EXACTLY (19,666,054 = 2 x 9,833,027)
//                     -> fromPct is inclusive, tier 2 (500) -> 491,651
//        seat ..924f    844,369 /    844,369  = 10,000 bps exactly -> tier 3 FROM is inclusive (800) -> 67,550
//        seat ..91fa    -60,990 /  1,000,000  = negative -> NO_TIER
//        seat ..9205  two quotas on the same period -> AMBIGUOUS_QUOTA
//        other NEW_BOOKING seats have no quota -> NO_QUOTA
//   TEST-NA-PR-TIER-CH   Tiered on CHANNEL_INV, the RULE's own quota TEST-Q-NA-CH (5,000,000):
//        207,060 -> 414 bps -> 200 -> 4,141  ·  414,120 -> 828 bps -> 8,282
//        4,706,940 -> 9,414 bps -> 500 -> 235,347
//   TEST-RT-NA           tiers [0,5000) 200 · [5000,10000) 500 · [10000,15000) 800
//
// IDEMPOTENT BY BUSINESS KEY: every row is looked up before it is created. The plan's
// payoutRules are SET with UPDATE_FIELDS, which touches that one property and nothing else.
// Writes TEST- rows only, and never deletes.

import { resolveEnv } from "./env.mjs";

const die = (m) => { console.error(`error: ${m}`); process.exit(1); };
const { env, baseUrl, headers, args } = resolveEnv({ write: true });
const cmd = args[0];
if (cmd !== "plan" && cmd !== "apply") die("usage: seed-payouts-na.mjs plan|apply [--env tool]");

const PERIOD_ID = "e_6aa2b98a35cc1f4f3c87919c";   // TEST-NA-JUL-2026
const JUL_START = 1782864000000;
const JUL_END = 1785456000000;

async function api(pathname, body) {
  const res = await fetch(baseUrl + pathname, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) die(`${pathname} -> HTTP ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}
async function findBy(type, field, value) {
  const out = await api(`/api/entity/${type}`, {
    filter: { op: "AND", values: [{ field: `properties.${field}`, op: "EQUAL", values: [value] }] },
    page: { limit: 2, offset: 0 },
  });
  const rows = out.response?.objects ?? out.objects ?? [];
  if (rows.length > 1) die(`${type} ${field}=${value} matches ${rows.length} rows - resolve by hand`);
  return rows[0] ?? null;
}
const log = [];
async function ensure(type, field, properties) {
  const value = properties[field];
  const existing = await findBy(type, field, value);
  if (existing) { log.push(`  = ${type.padEnd(20)} ${value}  (exists)`); return existing.id; }
  if (cmd === "plan") { log.push(`  + ${type.padEnd(20)} ${value}`); return `PLANNED:${type}:${value}`; }
  const out = await api("/api/entity/create-update-or-delete/hierarchical", { entity: { entityType: type, properties }, requestType: "CREATED" });
  const first = Array.isArray(out) ? out[0] : out;
  const id = first?.id ?? first?.entity?.id;
  if (!id) die(`${type} ${value}: create returned no id - ${JSON.stringify(out).slice(0, 300)}`);
  log.push(`  + ${type.padEnd(20)} ${value}  -> ${id}`);
  return id;
}

/** SET properties on an existing row when they differ - UPDATE_FIELDS touches only those. */
async function align(type, field, value, wanted) {
  const row = await findBy(type, field, value);
  if (!row) return;
  const diff = Object.entries(wanted).filter(([k, v]) => JSON.stringify(row.properties?.[k]) !== JSON.stringify(v));
  if (!diff.length) return;
  if (cmd === "plan") { log.push(`  ~ ${type.padEnd(20)} ${value}  ${diff.map(([k]) => k).join(", ")}`); return; }
  await api("/api/entity/create-update-or-delete/hierarchical", {
    entity: { entityType: type, id: row.id }, requestType: "UPDATE_FIELDS",
    updateFields: diff.map(([k, v]) => ({ fieldName: `properties.${k}`, actionType: "SET", setValue: v })),
  });
  const back = await findBy(type, field, value);
  for (const [k, v] of diff) if (JSON.stringify(back?.properties?.[k]) !== JSON.stringify(v)) die(`${type} ${value}.${k} did not land: ${JSON.stringify(back?.properties?.[k])}`);
  log.push(`  ~ ${type.padEnd(20)} ${value}  ${diff.map(([k]) => k).join(", ")}  (read back)`);
}

// ---------------------------------------------------------------- tiered config
// `creditTypes` is an untyped `object` column: an ARRAY written to it is stored as `{}`
// (probed 2026-09-11, the first apply of this seeder). So it is stored as {codes: [...]}.
const NB_TYPES = { codes: ["NEW_BOOKING"] };
const CH_TYPES = { codes: ["CHANNEL_INV"] };
const nb = await ensure("AttainmentMeasure", "measureId", {
  measureId: "TEST-AM-NA-NB", name: "TEST NA new bookings (safe to delete)", creditTypes: NB_TYPES, periodType: "Month" });
await align("AttainmentMeasure", "measureId", "TEST-AM-NA-NB", { creditTypes: NB_TYPES });
const ch = await ensure("AttainmentMeasure", "measureId", {
  measureId: "TEST-AM-NA-CH", name: "TEST NA channel inventory (safe to delete)", creditTypes: CH_TYPES, periodType: "Month" });
await align("AttainmentMeasure", "measureId", "TEST-AM-NA-CH", { creditTypes: CH_TYPES });

const rt = await ensure("RateTable", "rateTableId", {
  rateTableId: "TEST-RT-NA", name: "TEST NA tiers (safe to delete)", mode: "Rate", tiering: "Cliff", unitType: "Percent",
  version: 1, effectiveStart: JUL_START, description: "Three tiers: 2% below plan, 5% at plan, 8% above plan." });
for (const [n, from, to, value, label] of [[1, 0, 5000, 200, "Below plan"], [2, 5000, 10000, 500, "At plan"], [3, 10000, 15000, 800, "Above plan"]]) {
  await ensure("RateTableBand", "bandId", { bandId: `TEST-RT-NA-B${n}`, rateTableId: rt, fromPct: from, toPct: to, value, label });
}

const quota = (quotaId, positionId, measureId, amount, extra = {}) => ensure("Quota", "quotaId", {
  quotaId, name: `${quotaId} (safe to delete)`, positionId, measureId, periodId: PERIOD_ID, amount,
  quotaType: positionId ? "POSITION" : "PLAN", unitType: "CURRENCY", targetIncentive: 0,
  effectiveStart: JUL_START, effectiveEnd: JUL_END, tags: ["TEST"], ...extra });
await quota("TEST-Q-NA-NB-91D6", "e_6aa2b98d35cc1f4f3c8791d6", nb, 10000000);
await quota("TEST-Q-NA-NB-91E4", "e_6aa2b98e35cc1f4f3c8791e4", nb, 10000000);
await quota("TEST-Q-NA-NB-91EE", "e_6aa2b98e35cc1f4f3c8791ee", nb, 19666054);
await quota("TEST-Q-NA-NB-924F", "e_6aa2b99335cc1f4f3c87924f", nb, 844369);
await quota("TEST-Q-NA-NB-91FA", "e_6aa2b98f35cc1f4f3c8791fa", nb, 1000000);
await quota("TEST-Q-NA-NB-9205-A", "e_6aa2b98f35cc1f4f3c879205", nb, 1000000);
await quota("TEST-Q-NA-NB-9205-B", "e_6aa2b98f35cc1f4f3c879205", nb, 2000000);
await quota("TEST-Q-NA-CH", null, ch, 5000000);

// ---------------------------------------------------------------- payout rules
const rule = (ruleId, name, conditionType, values, sortOrder) => ensure("Rule", "ruleId", {
  ruleId, stage: "payout", name: `${name} (safe to delete)`, ruleType: "Commission", description: name,
  activeStart: JUL_START, activeEnd: JUL_END, rollableOnReporting: false, multiplier: "", tags: "TEST",
  conditions: { items: [{ connector: "If", subject: "credit.credit_type", operator: "==", value: conditionType }] },
  result: { name, rollable: false, values: { ...values, payWhen: "On close", sortOrder: String(sortOrder) } } });
await rule("TEST-NA-PR-FLAT", "TEST NA flat 5% on renewals", "RENEWAL",
  { rateType: "Flat rate", rateBps: "500", creditTypes: "RENEWAL" }, 1);
await rule("TEST-NA-PR-TIER-NB", "TEST NA tiered new bookings, payee quota", "NEW_BOOKING",
  { rateType: "Tiered", measureId: "TEST-AM-NA-NB", rateTableId: "TEST-RT-NA" }, 2);
await rule("TEST-NA-PR-TIER-CH", "TEST NA tiered channel inventory, rule quota", "CHANNEL_INV",
  { rateType: "Tiered", measureId: "TEST-AM-NA-CH", rateTableId: "TEST-RT-NA", quotaId: "TEST-Q-NA-CH" }, 3);

// ---------------------------------------------------------------- link to the plan
const PAYOUT_RULES = ["TEST-NA-PR-FLAT", "TEST-NA-PR-TIER-NB", "TEST-NA-PR-TIER-CH"];
const plan = await findBy("Plan", "planId", "TEST-NA-PLAN-01") ?? die("TEST-NA-PLAN-01 not found - run seed-na-sample.mjs first");
const current = plan.properties?.payoutRules ?? [];
if (JSON.stringify(current) === JSON.stringify(PAYOUT_RULES)) log.push(`  = Plan.payoutRules      TEST-NA-PLAN-01 already ${PAYOUT_RULES.join(", ")}`);
else if (cmd === "plan") log.push(`  ~ Plan.payoutRules      TEST-NA-PLAN-01 ${JSON.stringify(current)} -> ${JSON.stringify(PAYOUT_RULES)}`);
else {
  await api("/api/entity/create-update-or-delete/hierarchical", {
    entity: { entityType: "Plan", id: plan.id }, requestType: "UPDATE_FIELDS",
    updateFields: [{ fieldName: "properties.payoutRules", actionType: "SET", setValue: PAYOUT_RULES }],
  });
  const back = await findBy("Plan", "planId", "TEST-NA-PLAN-01");
  if (JSON.stringify(back?.properties?.payoutRules) !== JSON.stringify(PAYOUT_RULES)) die(`plan update did not land: ${JSON.stringify(back?.properties?.payoutRules)}`);
  log.push(`  ~ Plan.payoutRules      TEST-NA-PLAN-01 -> ${PAYOUT_RULES.join(", ")}  (read back)`);
}

console.log(`${cmd === "plan" ? "PLAN" : "APPLIED"} on ${env}`);
console.log(log.join("\n"));

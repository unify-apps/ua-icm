#!/usr/bin/env node
// Assemble the `ICM | Calculate Payouts` definition from the Groovy in
// automations/calculate-payouts/ (and the shared engine files in automations/calculate-credits/).
//
// Same discipline as build-calculate-credits.mjs: groupIds are DERIVED from the edges, every
// node must be reachable from START, and a Groovy node's `parameters` and `input` schema are
// generated from ONE list so they cannot disagree.
//
//   node scripts/build-calculate-payouts.mjs            # write build/calculate-payouts.json
//
// Spec: docs/automations/calculate-payouts.md

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAY = path.join(ROOT, "automations", "calculate-payouts");
const CRED = path.join(ROOT, "automations", "calculate-credits");
const pay = (f) => fs.readFileSync(path.join(PAY, f), "utf8");
const cred = (f) => fs.readFileSync(path.join(CRED, f), "utf8");
const die = (m) => { console.error(`error: ${m}`); process.exit(1); };

// ---------------------------------------------------------------- node helpers
const STORAGE = (resourceName) => ({ appName: "storage_by_unifyapps", resourceName: `storage_by_unifyapps_${resourceName}`, type: "APPLICATION" });
const GROOVY = { appName: "code_by_unifyapps", resourceName: "code_by_unifyapps_groovy", type: "APPLICATION" };
const OPTS = { disableLogging: false, enabledForReExecution: false, stepError: "STOP" };

const S = (n) => `{{ n_Shape.outputs.result.${n} }}`;
const N = (n) => `{{ n_Norm.outputs.result.${n} }}`;
const C = (n) => `{{ n_Calc.outputs.result.${n} }}`;
const KEY = (node, field) => `{{ ${node}.outputs.result.${field} }}`;

/** One page whose size the caller sets; `hasMore` goes to the fold, which refuses a truncated read. */
function fetchNode({ id, object, why, fields, filter, match = "AND" }) {
  const inputs = {
    shouldSearchInAnalyticsStore: false, object_type: object, includeRoleMappings: false,
    includeCurrentUserPermissions: false, translationsOption: "DEFAULT",
    page: { paginateBy: "OFFSET", limit: N("pageLimit"), offset: 0 },
    numberOfRecordsToFetch: "MULTIPLE", includeTotalCount: true, readThroughSessionVariables: false,
    fields: ["id", ...fields.map((f) => `properties.${f}`)],
  };
  // Structured, never a template string: drawable, and readable by the index analyser.
  if (filter) inputs.triggerInputCondition = { operator: match, filters: filter };
  return { context: STORAGE("fetch_records"), fallbackMode: "STOP", id, inputs, options: OPTS, skip: false, subTitle: why, title: `Fetch ${object}`, type: "ACTION" };
}
const EQ = (property, value) => ({ property, filter: { operator: "EQUAL", value } });
const LTE = (property, value) => ({ property, filter: { operator: "LTE", value } });
const GTE = (property, value) => ({ property, filter: { operator: "GTE", value } });
const IN = (property, value) => ({ property, filter: { operator: "IN", value } });

const mapped = (source) => ({ "ua:type": "mappedArray", source: `{{ ${source} }}`, items: `{{ ${source}[0] }}` });

/** params: "pill" string | {rows: fetchNodeId} | {list: "node.outputs.result.field"} | {bool} | {int} */
function groovyNode({ id, title, why, code, params, output }) {
  const properties = {};
  const parameters = {};
  for (const [name, spec] of Object.entries(params)) {
    if (typeof spec === "string") { properties[name] = { type: "string", title: name }; parameters[name] = spec; }
    else if (spec.rows || spec.list) {
      properties[name] = { type: "array", title: name, items: { type: "object", properties: {}, additionalProperties: false } };
      parameters[name] = mapped(spec.rows ? `${spec.rows}.outputs.objects` : spec.list);
    } else if (spec.bool !== undefined) { properties[name] = { type: "boolean", title: name }; parameters[name] = spec.bool; }
    else if (spec.int !== undefined) { properties[name] = { type: "integer", title: name }; parameters[name] = spec.int; }
    else die(`unknown param spec for ${id}.${name}`);
  }
  return {
    context: GROOVY, fallbackMode: "STOP", id,
    inputs: {
      output: { type: "object", additionalProperties: false, required: [], properties: titled(output) },
      input: { type: "object", additionalProperties: false, required: [], properties },
      code, compile_static: false, captureStdOutput: false, parameters,
    },
    options: OPTS, skip: false, subTitle: why, title, type: "ACTION",
  };
}
const titled = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { ...v, title: k }]));
const arr = { type: "array", items: { type: "string" } };
const objArr = { type: "array", items: { type: "object", properties: {} } };

const ifNode = ({ id, why, property, operator, value }) => ({
  context: { appName: "if_else", resourceName: "if_else_condition", type: "APPLICATION" },
  fallbackMode: "STOP", id, inputs: { filters: [{ property, filter: { operator, value } }], operator: "AND" },
  skip: false, subTitle: why, title: "Condition", type: "IF_ELSE",
});
const stopNode = ({ id, why, result }) => ({
  context: { appName: "callables", resourceName: "callables_return_to_automation", type: "APPLICATION" },
  fallbackMode: "STOP", id, inputs: { result }, skip: false, subTitle: why, title: "Respond to automation", type: "STOP",
});
const isTrue = (pill) => ({ operator: "AND", filters: [{ property: pill, filter: { operator: "EQUAL", value: true } }] });
function branchNodes({ id, why, lanes }) {
  return [
    { context: { appName: "branch", type: "APPLICATION" }, fallbackMode: "STOP", id,
      inputs: { branches: [...lanes.map((l) => ({ id: l.n, inputs: { name: l.name, conditions: isTrue(l.when) } })), { id: "default" }] },
      skip: false, subTitle: why, title: "Branch", type: "BRANCH" },
    ...lanes.map((l) => ({
      context: { appName: "branch_condition", resourceName: "branch_condition", resourceVersion: 0, type: "APPLICATION" },
      fallbackMode: "STOP", id: `${id}@${l.n}`, inputs: { name: l.name, conditions: isTrue(l.when) }, skip: false, title: "", type: "BRANCH_CONDITION",
    })),
  ];
}

// ---------------------------------------------------------------- the chain
// Each step names what it follows. Every read is keyed on the previous stage's keys.
const STEPS = [
  { kind: "fetch", id: "n_FtRun", object: "CalculationRun", param: null, after: "n_IfPer",
    why: "This period's finished runs - the credit run to pay from, and payout runs this one will supersede",
    fields: ["runId", "periodId", "status", "dryRun", "scope", "startedAt"],
    filter: [EQ("properties.periodId", N("periodId")), EQ("properties.status", "Succeeded")] },
  { kind: "groovy", id: "n_KRun", file: "keys-run.groovy", after: "n_FtRun", title: "Which credit run",
    why: "The latest Succeeded wet credit run; payout runs are never mistaken for one",
    params: { runRows: { rows: "n_FtRun" }, runMore: { bool: "{{ n_FtRun.outputs.hasMore }}" } },
    output: { found: { type: "boolean" }, status: { type: "string" }, message: { type: "string" },
      creditRunId: { type: "string" }, creditRunKey: { type: "string" }, payoutRunIds: arr } },
  { kind: "if", id: "n_IfRun", after: "n_KRun" },

  { kind: "fetch", id: "n_FtCredit", object: "Credit", param: "credit", after: "n_IfRun",
    why: "Every credit that run wrote - the only money this automation pays on",
    fields: ["creditId", "runId", "transactionId", "employeeId", "positionId", "creditTypeId", "amount", "sourceCreditId"],
    filter: [EQ("properties.runId", KEY("n_KRun", "creditRunId"))] },
  { kind: "groovy", id: "n_KCred", file: "keys-credit.groovy", after: "n_FtCredit", title: "Keys the credits carry",
    why: "Their transactions, seats and credit types - the key sets every later read is filtered by",
    params: { creditRows: { rows: "n_FtCredit" }, keyCap: { int: N("keyCap") } },
    output: { transactionIds: arr, positionIds: arr, creditTypeIds: arr, count: { type: "integer" }, overflow: { type: "boolean" } } },

  { kind: "fetch", id: "n_FtTxn", object: "Transaction", param: "txn", after: "n_KCred",
    why: "Each credit's date and deal facts - a credit row carries neither",
    fields: ["transactionId", "sourceId", "incentiveDate", "closeDate", "product", "customer", "attrs"],
    filter: [IN("id", KEY("n_KCred", "transactionIds"))] },
  { kind: "fetch", id: "n_FtCT", object: "CreditType", param: "ct", after: "n_FtTxn",
    why: "Credit type CODES - a rule and a measure name NEW_BOOKING, the credit stores an id",
    fields: ["creditTypeCode", "name"], filter: [IN("id", KEY("n_KCred", "creditTypeIds"))] },
  { kind: "fetch", id: "n_FtAttr", object: "PositionAttribute", param: "attr", after: "n_FtCT",
    why: "What the credited seats were on the credit date - their title decides the plan",
    fields: ["positionId", "titleId", "territoryId", "effectiveStart", "effectiveEnd"],
    filter: [IN("properties.positionId", KEY("n_KCred", "positionIds")), LTE("properties.effectiveStart", S("windowEnd"))] },
  { kind: "fetch", id: "n_FtPos", object: "Position", param: "pos", after: "n_FtAttr",
    why: "Seat codes - plan assignments name a seat by code as often as by id",
    fields: ["positionCode", "name"], filter: [IN("id", KEY("n_KCred", "positionIds"))] },
  { kind: "groovy", id: "n_KTitle", file: "@cred/keys-title.groovy", after: "n_FtPos", title: "Title ids",
    why: "The titles those seats carried", params: { attrRows: { rows: "n_FtAttr" } },
    output: { titleIds: arr, territoryIds: arr, count: { type: "integer" } } },
  { kind: "fetch", id: "n_FtTitle", object: "Title", param: "title", after: "n_KTitle",
    why: "Title codes, for assignments that name a title by code",
    fields: ["titleCode", "name"], filter: [IN("id", KEY("n_KTitle", "titleIds"))] },
  { kind: "groovy", id: "n_KAsg", file: "@cred/keys-asg.groovy", after: "n_FtTitle", title: "Every key an assignment might use",
    why: "Ids AND codes, in three columns",
    params: { positionIds: { list: "n_KCred.outputs.result.positionIds" }, titleIds: { list: "n_KTitle.outputs.result.titleIds" },
      posRows: { rows: "n_FtPos" }, titleRows: { rows: "n_FtTitle" } },
    output: { positionKeys: arr, titleKeys: arr, allKeys: arr, count: { type: "integer" } } },
  { kind: "fetch", id: "n_FtAsg", object: "PlanAssignment", param: "asg", after: "n_KAsg", match: "OR",
    why: "Plan assignments naming these seats or titles, in any of the three columns",
    fields: ["planId", "targetType", "targetId", "titleId", "positionId", "startDate", "endDate"],
    filter: [IN("properties.targetId", KEY("n_KAsg", "allKeys")), IN("properties.positionId", KEY("n_KAsg", "positionKeys")),
      IN("properties.titleId", KEY("n_KAsg", "titleKeys"))] },
  { kind: "groovy", id: "n_KPlan", file: "@cred/keys-plan.groovy", after: "n_FtAsg", title: "Plan ids",
    why: "The plans those assignments point at", params: { asgRows: { rows: "n_FtAsg" } },
    output: { planIds: arr, count: { type: "integer" } } },
  { kind: "fetch", id: "n_FtPlan", object: "Plan", param: "plan", after: "n_KPlan",
    why: "Only those plans - their payoutRules list is what this automation applies",
    fields: ["planId", "name", "status", "startDate", "endDate", "payoutRules"], filter: [IN("id", KEY("n_KPlan", "planIds"))] },
  { kind: "groovy", id: "n_KRule", file: "keys-payout-rule.groovy", after: "n_FtPlan", title: "Payout rule keys",
    why: "Plan.payoutRules holds business keys", params: { planRows: { rows: "n_FtPlan" } },
    output: { ruleIds: arr, count: { type: "integer" } } },
  { kind: "fetch", id: "n_FtRule", object: "Rule", param: "rule", after: "n_KRule",
    why: "Only the payout rules those plans list",
    fields: ["ruleId", "stage", "name", "conditions", "result", "activeStart", "activeEnd"],
    filter: [IN("properties.ruleId", KEY("n_KRule", "ruleIds")), EQ("properties.stage", "payout")] },
  { kind: "groovy", id: "n_KNeed", file: "keys-tier.groovy", after: "n_FtRule", title: "Do any rules need tiers",
    why: "Which measures, rate tables and quotas the tiered rules name - none means those reads never run",
    params: { ruleRows: { rows: "n_FtRule" } },
    output: { measureIds: arr, rateTableIds: arr, quotaIds: arr, readTiered: { type: "boolean" } } },

  { kind: "branch", id: "n_BrTier", after: "n_KNeed", join: "n_Calc",
    why: "Tiered config is read only when a tiered rule applies",
    lanes: [{ n: "1", name: "Tiered config", when: KEY("n_KNeed", "readTiered"), end: "n_FtCover" }] },
  { kind: "fetch", id: "n_FtMeasure", object: "AttainmentMeasure", param: "measure", after: "n_BrTier@1",
    why: "Which credit types count towards attainment",
    fields: ["measureId", "name", "creditTypes", "periodType"], filter: [IN("properties.measureId", KEY("n_KNeed", "measureIds"))] },
  { kind: "fetch", id: "n_FtRT", object: "RateTable", param: "rt", after: "n_FtMeasure",
    why: "The rate tables the tiered rules name",
    fields: ["rateTableId", "name", "effectiveStart", "effectiveEnd"], filter: [IN("properties.rateTableId", KEY("n_KNeed", "rateTableIds"))] },
  { kind: "groovy", id: "n_KRT", file: "keys-band.groovy", after: "n_FtRT", title: "Rate table record ids",
    why: "Tiers point at the table's RECORD id, the rule at its business key", params: { rtRows: { rows: "n_FtRT" } },
    output: { rateTableRecordIds: arr, count: { type: "integer" } } },
  { kind: "fetch", id: "n_FtBand", object: "RateTableBand", param: "band", after: "n_KRT",
    why: "The tiers of those tables",
    fields: ["bandId", "rateTableId", "fromPct", "toPct", "value", "label"], filter: [IN("properties.rateTableId", KEY("n_KRT", "rateTableRecordIds"))] },
  { kind: "fetch", id: "n_FtQuota", object: "Quota", param: "quota", after: "n_FtBand", match: "OR",
    why: "Quotas on the credited seats, and any quota a rule names directly",
    fields: ["quotaId", "name", "positionId", "measureId", "periodId", "amount", "effectiveStart", "effectiveEnd"],
    filter: [IN("properties.positionId", KEY("n_KCred", "positionIds")), IN("properties.quotaId", KEY("n_KNeed", "quotaIds"))] },
  { kind: "fetch", id: "n_FtCover", object: "Period", param: "cover", after: "n_FtQuota",
    why: "This period and the periods containing it - a seat's quota may sit on the quarter or the year",
    fields: ["name", "periodType", "startDate", "endDate"],
    filter: [LTE("properties.startDate", S("windowStart")), GTE("properties.endDate", S("windowEnd"))] },
];

const FETCHES = STEPS.filter((s) => s.kind === "fetch" && s.param);
const BRANCHES = STEPS.filter((s) => s.kind === "branch");

const calcParams = {
  runId: N("runId"), startedAt: { int: N("startedAt") }, dryRun: { bool: N("dryRun") }, periodId: N("periodId"),
  periodName: S("periodName"), windowStart: { int: S("windowStart") }, windowEnd: { int: S("windowEnd") },
  creditRunKey: KEY("n_KRun", "creditRunKey"), creditOverflow: { bool: KEY("n_KCred", "overflow") },
};
for (const f of FETCHES) {
  calcParams[`${f.param}Rows`] = { rows: f.id };
  calcParams[`${f.param}More`] = { bool: `{{ ${f.id}.outputs.hasMore }}` };
}

const RESULT_SHAPE = {
  status: { type: "string" }, message: { type: "string" }, runId: { type: "string" }, periodName: { type: "string" },
  creditRunId: { type: "string" }, dryRun: { type: "boolean" }, written: { type: "integer" },
  earnings: objArr, measureResults: objArr, exceptions: objArr, stats: { type: "object", properties: {} },
};
const answer = (status, message, extra = {}) => ({
  status, message, runId: N("runId"), periodName: "", creditRunId: "", dryRun: N("dryRun"), written: 0,
  earnings: [], measureResults: [], exceptions: [], stats: {}, ...extra,
});
const fromCalc = (status, written) => ({
  status, message: C("message"), runId: C("runId"), periodName: C("periodName"), creditRunId: C("creditRunId"),
  dryRun: C("dryRun"), written, earnings: mapped("n_Calc.outputs.result.earnings"),
  measureResults: mapped("n_Calc.outputs.result.measureResults"), exceptions: mapped("n_Calc.outputs.result.exceptions"),
  stats: C("stats"),
});

const src = (file) => (file.startsWith("@cred/") ? cred(file.slice(6)) : pay(file));

const nodes = [
  { context: { appName: "callables", resourceName: "callables_from_automation" }, fallbackMode: "STOP", id: "n_Start",
    inputs: {
      result: { type: "object", additionalProperties: false, required: ["status"], properties: RESULT_SHAPE },
      setup: { type: "object", additionalProperties: false, required: ["periodId"], properties: {
        periodId: { type: "string", title: "Period Id" }, dryRun: { type: "boolean", title: "Dry Run" },
        pageLimit: { type: "integer", title: "Page Limit" }, keyCap: { type: "integer", title: "Key Cap" } } },
    },
    skip: false, subTitle: "Callable - one period in, its earnings out", title: "Trigger via automation", trigger: { type: "CALLABLE" }, type: "START" },

  groovyNode({ id: "n_Norm", title: "Normalise the request", why: "Defaults, a sentinel for an unusable period, and the run id",
    code: cred("n_Norm.groovy"),
    params: { periodId: "{{ n_Start.outputs.periodId }}", dryRun: "{{ n_Start.outputs.dryRun }}",
      pageLimit: "{{ n_Start.outputs.pageLimit }}", keyCap: "{{ n_Start.outputs.keyCap }}" },
    output: { periodId: { type: "string" }, inputOk: { type: "boolean" }, dryRun: { type: "boolean" }, pageLimit: { type: "integer" },
      keyCap: { type: "integer" }, runId: { type: "string" }, startedAt: { type: "integer" } } }),
  fetchNode({ id: "n_FtPeriod", object: "Period", why: "The one period this run pays",
    fields: ["name", "periodType", "status", "startDate", "endDate"], filter: [EQ("id", N("periodId"))] }),
  groovyNode({ id: "n_Shape", title: "Read the period", why: "May this period be paid, and over what dates",
    code: cred("n_Shape.groovy"),
    params: { periodId: N("periodId"), inputOk: { bool: N("inputOk") }, periodRows: { rows: "n_FtPeriod" } },
    output: { ok: { type: "boolean" }, status: { type: "string" }, message: { type: "string" }, periodName: { type: "string" },
      windowStart: { type: "integer" }, windowEnd: { type: "integer" } } }),
  ifNode({ id: "n_IfPer", why: "Is the period unusable?", property: S("ok"), operator: "EQUAL", value: false }),
  stopNode({ id: "n_RespPer", why: "Refuse with the reason, before a single credit is read", result: answer(S("status"), S("message")) }),

  ...STEPS.flatMap((st) => {
    if (st.kind === "fetch") return [fetchNode(st)];
    if (st.kind === "groovy") return [groovyNode({ id: st.id, title: st.title, why: st.why, code: src(st.file), params: st.params, output: st.output })];
    if (st.kind === "branch") return branchNodes(st);
    if (st.id === "n_IfRun") return [
      ifNode({ id: "n_IfRun", why: "Has this period been credited at all?", property: KEY("n_KRun", "found"), operator: "EQUAL", value: false }),
      stopNode({ id: "n_RespRun", why: "No credit run to pay from - never credited, or the run list did not fit one page",
        result: answer(KEY("n_KRun", "status"), KEY("n_KRun", "message"), { periodName: S("periodName") }) }),
    ];
    return die(`unknown step ${st.id}`);
  }),

  groovyNode({ id: "n_Calc", title: "Calculate payouts", why: "Credit to plan to payout rule to earning - flat and tiered, no I/O",
    code: [cred("ConditionMatcher.groovy"), cred("CreditPass.groovy"), pay("PayoutPass.groovy"), pay("n_Calc.groovy")].join("\n\n"),
    params: calcParams,
    output: { ...RESULT_SHAPE, expectedEarnings: { type: "integer" }, expectedResults: { type: "integer" } } }),
  ifNode({ id: "n_IfCalc", why: "Did the fold refuse to answer?", property: C("status"), operator: "NOT_EQUAL", value: "OK" }),
  stopNode({ id: "n_RespCalc", why: "A truncated read is a wrong answer, so it is returned as one", result: fromCalc(C("status"), 0) }),
  ifNode({ id: "n_IfDry", why: "Compute and report, or actually write?", property: C("dryRun"), operator: "EQUAL", value: true }),
  stopNode({ id: "n_RespDry", why: "What WOULD be paid, and everything that could not be decided", result: fromCalc("OK_DRY_RUN", 0) }),

  { context: { ...STORAGE("create_record"), resourceVersion: 864 }, fallbackMode: "STOP", id: "n_CrRun",
    inputs: { writeThroughSessionVariables: false, object_type: "CalculationRun",
      record: { runId: N("runId"), periodId: N("periodId"), status: "Running", startedAt: N("startedAt"), dryRun: false,
        stats: C("stats"), scope: { stage: "payout", creditRunId: C("creditRunId") } } },
    options: OPTS, skip: false, subTitle: "The payout run the earnings hang off - Running until they land", title: "Create record", type: "ACTION" },
  groovyNode({ id: "n_Stamp", title: "Shape the rows", why: "Stamp the run id and build updateFields - a flat row writes nothing",
    code: pay("n_Stamp.groovy"),
    params: { runId: "{{ n_CrRun.outputs.id }}", periodId: N("periodId"),
      earnings: { list: "n_Calc.outputs.result.earnings" }, measureResults: { list: "n_Calc.outputs.result.measureResults" } },
    output: { mrUpdates: objArr, earnUpdates: objArr, mrExpected: { type: "integer" }, earnExpected: { type: "integer" } } }),
  { context: { ...STORAGE("bulk_upsert_records_by_id"), resourceVersion: 864 }, fallbackMode: "STOP", id: "n_WrMR",
    inputs: { object_type: "MeasureResult", skipIfBlank: false, skipSchemaValidation: true,
      updates: "{{ n_Stamp.outputs.result.mrUpdates }}", unsetIfNull: false },
    options: OPTS, skip: false, subTitle: "Attainment per payee and measure, before the earnings that point at it",
    title: "Bulk upsert records by id", type: "ACTION" },
  { context: { ...STORAGE("bulk_upsert_records_by_id"), resourceVersion: 864 }, fallbackMode: "STOP", id: "n_WrEarn",
    inputs: { object_type: "Earning", skipIfBlank: false, skipSchemaValidation: true,
      updates: "{{ n_Stamp.outputs.result.earnUpdates }}", unsetIfNull: false },
    options: OPTS, skip: false, subTitle: "Every earning, by its minted id, in one call", title: "Bulk upsert records by id", type: "ACTION" },
  groovyNode({ id: "n_RunEnd", title: "Close the run", why: "Compare what landed against what was meant; supersede older payout runs only on success",
    code: pay("n_RunEnd.groovy"),
    params: { runRecordId: "{{ n_CrRun.outputs.id }}",
      mrLanded: { int: "{{ n_WrMR.outputs.successCount }}" }, mrExpected: { int: "{{ n_Stamp.outputs.result.mrExpected }}" },
      earnLanded: { int: "{{ n_WrEarn.outputs.successCount }}" }, earnExpected: { int: "{{ n_Stamp.outputs.result.earnExpected }}" },
      supersede: { list: "n_KRun.outputs.result.payoutRunIds" } },
    output: { ok: { type: "boolean" }, landed: { type: "integer" }, message: { type: "string" }, updates: objArr } }),
  { context: { ...STORAGE("bulk_upsert_records_by_id"), resourceVersion: 864 }, fallbackMode: "STOP", id: "n_UpRun",
    inputs: { object_type: "CalculationRun", skipIfBlank: false, skipSchemaValidation: true,
      updates: "{{ n_RunEnd.outputs.result.updates }}", unsetIfNull: false },
    options: OPTS, skip: false, subTitle: "Succeeded or Failed, and older payout runs Superseded", title: "Bulk upsert records by id", type: "ACTION" },
  ifNode({ id: "n_IfWr", why: "Did everything actually land?", property: "{{ n_RunEnd.outputs.result.ok }}", operator: "EQUAL", value: false }),
  stopNode({ id: "n_RespPart", why: "Some rows did not land - say so, with the run left Failed",
    result: { ...fromCalc("EARNING_WRITE_INCOMPLETE", "{{ n_RunEnd.outputs.result.landed }}"), message: "{{ n_RunEnd.outputs.result.message }}" } }),
  stopNode({ id: "n_RespOk", why: "Earnings written, run marked Succeeded", result: fromCalc("OK", "{{ n_RunEnd.outputs.result.landed }}") }),
];

const byIdType = Object.fromEntries(nodes.map((n) => [n.id, n.type]));
const edges = [
  ["next", "n_Start", "n_Norm"], ["next", "n_Norm", "n_FtPeriod"], ["next", "n_FtPeriod", "n_Shape"], ["next", "n_Shape", "n_IfPer"],
  ["if", "n_IfPer", "n_RespPer"],
  ["if", "n_IfRun", "n_RespRun"],
  ...STEPS.filter((st) => st.after).map((st) => ["next", st.after, st.id]),
  ...BRANCHES.flatMap((b) => [
    ...b.lanes.map((l) => ["branch", b.id, `${b.id}@${l.n}`, l.n]),
    ["branch", b.id, b.join, "default"],
    ...b.lanes.map((l) => ["next", l.end, b.join]),
  ]),
  ["next", "n_Calc", "n_IfCalc"], ["if", "n_IfCalc", "n_RespCalc"], ["next", "n_IfCalc", "n_IfDry"],
  ["if", "n_IfDry", "n_RespDry"], ["next", "n_IfDry", "n_CrRun"],
  ["next", "n_CrRun", "n_Stamp"], ["next", "n_Stamp", "n_WrMR"], ["next", "n_WrMR", "n_WrEarn"], ["next", "n_WrEarn", "n_RunEnd"],
  ["next", "n_RunEnd", "n_UpRun"], ["next", "n_UpRun", "n_IfWr"], ["if", "n_IfWr", "n_RespPart"], ["next", "n_IfWr", "n_RespOk"],
].map(([type, from, to, name]) => ({
  fromNodeId: from, toNodeId: to, type,
  id: type === "branch" ? `branch@${from}@${to}` : `${type}@${from}@${to}`,
  name: name ?? (byIdType[from] === "IF_ELSE" ? (type === "if" ? "yes" : "no") : undefined),
  priority: 0, skip: false,
})).map((e) => (e.name === undefined ? (delete e.name, e) : e));

// ------------------------------------------------- derive groupId, never type it
const byId = new Map(nodes.map((n) => [n.id, n]));
for (const e of edges) {
  if (!byId.has(e.fromNodeId)) die(`edge ${e.id}: no node ${e.fromNodeId}`);
  if (!byId.has(e.toNodeId)) die(`edge ${e.id}: no node ${e.toNodeId}`);
}
const out = new Map();
for (const e of edges) { if (!out.has(e.fromNodeId)) out.set(e.fromNodeId, []); out.get(e.fromNodeId).push(e); }
const ROOT_GROUP = "root_id-1";
const depth = (g) => g.split("@").length;
const groups = new Map([["n_Start", ROOT_GROUP]]);
const queue = ["n_Start"];
while (queue.length) {
  const id = queue.shift();
  const node = byId.get(id);
  const g = groups.get(id);
  for (const e of out.get(id) ?? []) {
    let child;
    if (node.type === "IF_ELSE") child = `${id}@${g}@${e.type === "if" ? "y" : "n"}`;
    else if (node.type === "BRANCH") child = e.name === "default" ? g : `${id}@${g}@${e.name}`;
    else child = g;
    const seen = groups.get(e.toNodeId);
    if (seen !== undefined && depth(seen) <= depth(child)) continue;
    groups.set(e.toNodeId, child);
    queue.push(e.toNodeId);
  }
}
const unreached = nodes.filter((n) => !groups.has(n.id)).map((n) => n.id);
if (unreached.length) die(`unreachable from START: ${unreached.join(", ")}`);
nodes.forEach((n, i) => { n.groupId = groups.get(n.id); n.index = i + 1; n.debug = false; n.dirty = false; });

for (const n of nodes) {
  if (n.context?.resourceName !== GROOVY.resourceName) continue;
  const p = n.inputs?.parameters ?? {};
  if (!Object.keys(p).length) die(`${n.id} has code but binds no parameters`);
  const declared = new Set(Object.keys(n.inputs.input.properties));
  for (const k of Object.keys(p)) if (!declared.has(k)) die(`${n.id} binds ${k} but does not declare it`);
}

const definition = { name: "ICM | Calculate Payouts", description:
  "Turns the credits of one period's latest finished credit run into Earning rows: each credit's plan is resolved as of "
  + "its date, and every payout rule on that plan pays either a flat rate on the credit or a tiered rate chosen by the "
  + "payee's attainment against a quota. Dry run by default.",
  nodes, edges, settings: {}, standard: false };

const dest = path.join(ROOT, "build", "calculate-payouts.json");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(definition, null, 1));
console.log(`wrote ${path.relative(ROOT, dest)}`);
console.log(`  nodes ${nodes.length}  edges ${edges.length}  groovy ${nodes.filter((n) => n.context?.resourceName === GROOVY.resourceName).length}  fetches ${nodes.filter((n) => n.context?.resourceName === "storage_by_unifyapps_fetch_records").length}`);
for (const n of nodes) if (n.groupId !== ROOT_GROUP) console.log(`  ${n.id.padEnd(12)} ${n.groupId}`);

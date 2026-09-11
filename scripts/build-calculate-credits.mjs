#!/usr/bin/env node
// Assemble the `ICM | Calculate Credits` definition from the Groovy in
// automations/calculate-credits/ and the graph declared below.
//
// WHY A BUILDER AND NOT A HAND-WRITTEN JSON. `groupId` is what the BUILDER draws the
// branch tree from, and a graph whose groups are wrong still EXECUTES — the runtime
// picks branches by edge type. It breaks the first time a human opens it: the builder
// cannot place a node it has no group for and re-serialising SILENTLY DROPS it
// (`ICM | Create Position` went 16 nodes -> 5 that way). So groups are DERIVED here by
// walking the edges from START, never typed, and any node the walk does not reach is a
// hard failure rather than a row in the output.
//
//   node scripts/build-calculate-credits.mjs            # write build/calculate-credits.json
//
// Then: ua-automation.mjs plan|create, ua.mjs validate, testrun.mjs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "automations", "calculate-credits");
const src = (f) => fs.readFileSync(path.join(SRC, f), "utf8");

const die = (m) => { console.error(`error: ${m}`); process.exit(1); };

// ---------------------------------------------------------------- node helpers
const STORAGE = (resourceName) => ({ appName: "storage_by_unifyapps", resourceName: `storage_by_unifyapps_${resourceName}`, type: "APPLICATION" });
const GROOVY = { appName: "code_by_unifyapps", resourceName: "code_by_unifyapps_groovy", type: "APPLICATION" };
const OPTS = { disableLogging: false, enabledForReExecution: false, stepError: "STOP" };

/** Every fetch is bounded the same way: one page whose size the CALLER sets, and
 *  `hasMore` carried into the fold so a truncated page is refused, never averaged. */
function fetchNode({ id, object, title, why, fields, filter, match = "AND" }) {
  const inputs = {
    shouldSearchInAnalyticsStore: false,
    object_type: object,
    includeRoleMappings: false,
    includeCurrentUserPermissions: false,
    translationsOption: "DEFAULT",
    page: { paginateBy: "OFFSET", limit: "{{ n_Norm.outputs.result.pageLimit }}", offset: 0 },
    numberOfRecordsToFetch: "MULTIPLE",
    includeTotalCount: true,
    readThroughSessionVariables: false,
    fields: ["id", ...fields.map((f) => `properties.${f}`)],
  };
  // A STRUCTURED tree, never a template string: the builder's filter editor can draw
  // one and the missing-index analyser can read one. A whole-value template renders as
  // an empty condition row AND silently suppresses every index warning for the node.
  // `match: "OR"` is a flat top-level OR - still structured, still drawable.
  if (filter) inputs.triggerInputCondition = { operator: match, filters: filter };
  return { context: STORAGE("fetch_records"), fallbackMode: "STOP", id, inputs, options: OPTS, skip: false, subTitle: why, title, type: "ACTION" };
}

const EQ = (property, value) => ({ property, filter: { operator: "EQUAL", value } });
const LTE = (property, value) => ({ property, filter: { operator: "LTE", value } });
const GTE = (property, value) => ({ property, filter: { operator: "GTE", value } });
/** The whole redesign in one helper: each read is keyed on what the PREVIOUS stage
 *  proved it needs. An empty IN matches nothing rather than everything, and the
 *  extractors send a `['__none__']` sentinel so the shape stays fixed and drawable. */
const IN = (property, value) => ({ property, filter: { operator: "IN", value } });

/** A Groovy node. `parameters` is what BINDS; `input` is only what the builder draws
 *  the Parameters form from. They drift the moment one is edited without the other,
 *  so both are generated from ONE list here and can never disagree. */
function groovyNode({ id, title, why, code, params, output }) {
  const properties = {};
  const parameters = {};
  for (const [name, spec] of Object.entries(params)) {
    if (typeof spec === "string") {
      properties[name] = { type: "string", title: name };
      parameters[name] = spec;
    } else if (spec.rows) {
      // An ARRAY property renders as MappedArrayField, which accepts a literal array or
      // a {ua:type, source, items} object - never a bare pill. `items` must be the WHOLE
      // element: mapping to `.properties` strips `id`, the node still runs, and every
      // lookup built from that id matches nothing.
      properties[name] = { type: "array", title: name, items: { type: "object", properties: {}, additionalProperties: false } };
      parameters[name] = { "ua:type": "mappedArray", source: `{{ ${spec.rows}.outputs.objects }}`, items: `{{ ${spec.rows}.outputs.objects[0] }}` };
    } else if (spec.bool !== undefined) {
      properties[name] = { type: "boolean", title: name };
      parameters[name] = spec.bool;
    } else if (spec.int !== undefined) {
      properties[name] = { type: "integer", title: name };
      parameters[name] = spec.int;
    } else die(`unknown param spec for ${name}`);
  }
  return {
    context: GROOVY, fallbackMode: "STOP", id,
    inputs: {
      output: { type: "object", additionalProperties: false, required: [], properties: output },
      input: { type: "object", additionalProperties: false, required: [], properties },
      code, compile_static: false, captureStdOutput: false, parameters,
    },
    options: OPTS, skip: false, subTitle: why, title, type: "ACTION",
  };
}

const ifNode = ({ id, why, property, operator, value }) => ({
  // appName is `if_else`, resourceName `if_else_condition`. A node whose appName is the
  // resourceName RUNS but shows "no actions found" and an empty panel in the builder.
  context: { appName: "if_else", resourceName: "if_else_condition", type: "APPLICATION" },
  fallbackMode: "STOP", id,
  // Filters sit at the TOP level of inputs. Wrapped as {conditions:{...}} the runtime
  // sees no filters at all and the condition is silently FALSE.
  inputs: { filters: [{ property, filter: { operator, value } }], operator: "AND" },
  skip: false, subTitle: why, title: "Condition", type: "IF_ELSE",
});

const stopNode = ({ id, why, result }) => ({
  context: { appName: "callables", resourceName: "callables_return_to_automation", type: "APPLICATION" },
  fallbackMode: "STOP", id, inputs: { result }, skip: false, subTitle: why,
  title: "Respond to automation", type: "STOP",
});

// ------------------------------------------------------------------- the graph
const S = (n) => `{{ n_Shape.outputs.result.${n} }}`;
const N = (n) => `{{ n_Norm.outputs.result.${n} }}`;
const C = (n) => `{{ n_Calc.outputs.result.${n} }}`;

// ---------------------------------------------------------------- the staged chain
//
// WHY A CHAIN, AND WHY MOST OF THE TAIL IS CONDITIONAL.
//
// Every read is keyed on what the PREVIOUS stage proved it needs, and every read the
// rules do not need is never made. Two rules produce that shape:
//
//   1. KEYED, NOT WHOLE-TABLE. Cost grows with the work, not with headcount:
//
//      Transaction (period window)
//        -> distinct payee NAMES     -> Payee              by name IN
//        -> payee ids                -> their seats        by payeeId IN
//        -> the seats                -> PositionAttribute  by positionId IN
//                                    -> Position codes     by id IN
//        -> title ids                -> Title              by id IN
//        -> ids AND codes            -> PlanAssignment     ONE structured OR over three columns
//        -> plan ids                 -> Plan               by id IN
//        -> rule keys                -> Rule               by ruleId IN
//
//   2. NEEDED, NOT ASSUMED. Once the rules are known, n_KNeed decides what is left:
//
//        CreditType   the codes the rules file under            (lane 3)
//        Territory    only if a condition reads position.territory (lane 1)
//        Currency     only if a condition reads payee.currency     (lane 2)
//        hierarchy    only if a rule rolls up, one hop per level it asks for (lane 4)
//        managers     the occupants of the seats those hops found  (lane 4)
//
//      A lane whose condition is false is a fetch that never executes. A plan that rolls
//      up one level reads ONE hierarchy hop, not four; a plan with no rollup reads none.
//
// WHAT IT IS NOT: a fetch per payee, or per transaction. At 2,917 NA rows in one month
// that is ~12,000 round trips inside one run. The dependency is honoured one SET at a
// time, never one ROW at a time.
//
// Calls, before -> after: 21 on every run -> 11 minimum (no rollup, no territory or
// currency condition), 13 for NA (one-level rollup), 18 ceiling (four-level rollup and
// both conditions). Every read that runs returns exactly the rows it did before.
const KEY = (node, field) => `{{ ${node}.outputs.result.${field} }}`;
const HIER_FIELDS = ["positionId", "parentPositionId", "effectiveStart", "effectiveEnd"];
const OCC_FIELDS = ["payeeId", "positionId", "effectiveStart", "effectiveEnd"];
const isTrue = (pill) => ({ operator: "AND", filters: [{ property: pill, filter: { operator: "EQUAL", value: true } }] });

// Each entry is one step in execution order. `after` names the node it follows; a step
// with no `after` is a branch JOIN, reached by its branch's default edge and lane ends.
const STEPS = [
  { kind: "fetch", id: "n_FtTxn", object: "Transaction", param: "txn", after: "n_IfPer",
    why: "Deals whose incentive date lands in the period - the only unkeyed read, because it IS the scope",
    fields: ["transactionId", "sourceId", "positionId", "closeDate", "incentiveDate", "amount", "product", "customer", "attrs"],
    filter: [GTE("properties.incentiveDate", S("windowStart")), LTE("properties.incentiveDate", S("windowEnd"))] },

  { kind: "groovy", id: "n_KName", file: "keys-names.groovy", after: "n_FtTxn", title: "Whose deals are these",
    why: "Distinct payee names in the period - the key set every later read is filtered by",
    params: { txnRows: { rows: "n_FtTxn" }, keyCap: { int: N("keyCap") } },
    output: { names: { type: "array", items: { type: "string" } }, count: { type: "integer" },
      noName: { type: "integer" }, overflow: { type: "boolean" } } },

  { kind: "fetch", id: "n_FtPayee", object: "Payee", param: "payee", after: "n_KName",
    why: "Only the people this period's deals name - not the directory",
    fields: ["employeeId", "name", "currencyId", "hireDate", "terminationDate", "status"],
    filter: [IN("properties.name", KEY("n_KName", "names"))] },

  { kind: "groovy", id: "n_KPayee", file: "keys-payee.groovy", after: "n_FtPayee", title: "Payee ids",
    why: "The record ids those names resolved to. A name that resolved to nothing is a per-ROW verdict, not a run failure",
    params: { payeeRows: { rows: "n_FtPayee" } },
    output: { payeeIds: { type: "array", items: { type: "string" } }, count: { type: "integer" } } },

  { kind: "fetch", id: "n_FtOcc", object: "PayeePositionAssignment", param: "occ", after: "n_KPayee",
    why: "The seats THOSE payees held, in force on or before the window end",
    fields: OCC_FIELDS,
    filter: [IN("properties.payeeId", KEY("n_KPayee", "payeeIds")), LTE("properties.effectiveStart", S("windowEnd"))] },

  { kind: "groovy", id: "n_KSeat", file: "keys-seat.groovy", after: "n_FtOcc", title: "The seats in play",
    why: "Only the seats those payees held - not every seat in the org",
    params: { occRows: { rows: "n_FtOcc" }, keyCap: { int: N("keyCap") } },
    output: { positionIds: { type: "array", items: { type: "string" } }, count: { type: "integer" }, overflow: { type: "boolean" } } },

  { kind: "fetch", id: "n_FtAttr", object: "PositionAttribute", param: "attr", after: "n_KSeat",
    why: "What those seats WERE - title and territory - over a date range",
    fields: ["positionId", "titleId", "territoryId", "effectiveStart", "effectiveEnd"],
    filter: [IN("properties.positionId", KEY("n_KSeat", "positionIds")), LTE("properties.effectiveStart", S("windowEnd"))] },

  { kind: "fetch", id: "n_FtPos", object: "Position", param: "pos", after: "n_FtAttr",
    why: "Seat CODES - live plan assignments name a seat as POS-UK-AE-02 as often as by id",
    fields: ["positionCode", "name", "active"],
    filter: [IN("id", KEY("n_KSeat", "positionIds"))] },

  { kind: "groovy", id: "n_KTitle", file: "keys-title.groovy", after: "n_FtPos", title: "Title ids those seats carried",
    why: "Titles are fetched by id because the CODE is load-bearing - a rule stores T-AE, the seat stores a record id",
    params: { attrRows: { rows: "n_FtAttr" } },
    output: { titleIds: { type: "array", items: { type: "string" } },
      territoryIds: { type: "array", items: { type: "string" } }, count: { type: "integer" } } },

  { kind: "fetch", id: "n_FtTitle", object: "Title", param: "title", after: "n_KTitle",
    why: "Title CODES - a rule stores T-AE, the seat stores a record id",
    fields: ["titleCode", "name"],
    filter: [IN("id", KEY("n_KTitle", "titleIds"))] },

  { kind: "groovy", id: "n_KAsg", file: "keys-asg.groovy", after: "n_FtTitle", title: "Every key an assignment might use",
    why: "Ids AND codes, because the live data names targets both ways in three different columns",
    params: { positionIds: { rows: "__inline__" }, titleIds: { rows: "__inline__" },
      posRows: { rows: "n_FtPos" }, titleRows: { rows: "n_FtTitle" } },
    output: { positionKeys: { type: "array", items: { type: "string" } },
      titleKeys: { type: "array", items: { type: "string" } },
      allKeys: { type: "array", items: { type: "string" } }, count: { type: "integer" } } },

  { kind: "fetch", id: "n_FtAsg", object: "PlanAssignment", param: "asg", after: "n_KAsg",
    why: "Assignments naming these seats or titles in ANY of the three columns - one OR, not three reads",
    fields: ["planId", "targetType", "targetId", "titleId", "positionId", "startDate", "endDate"],
    match: "OR",
    filter: [IN("properties.targetId", KEY("n_KAsg", "allKeys")),
      IN("properties.positionId", KEY("n_KAsg", "positionKeys")),
      IN("properties.titleId", KEY("n_KAsg", "titleKeys"))] },

  { kind: "groovy", id: "n_KPlan", file: "keys-plan.groovy", after: "n_FtAsg", title: "Plan ids",
    why: "The plans those assignments point at, de-duplicated",
    params: { asgRows: { rows: "n_FtAsg" } },
    output: { planIds: { type: "array", items: { type: "string" } }, count: { type: "integer" } } },

  { kind: "fetch", id: "n_FtPlan", object: "Plan", param: "plan", after: "n_KPlan",
    why: "Only the plans those assignments point at - status is judged in the fold, not filtered here",
    fields: ["planId", "name", "status", "startDate", "endDate", "creditRules"],
    filter: [IN("id", KEY("n_KPlan", "planIds"))] },

  { kind: "groovy", id: "n_KRule", file: "keys-rule.groovy", after: "n_FtPlan", title: "Rule keys those plans list",
    why: "Plan.creditRules holds BUSINESS keys, so the Rule fetch filters on properties.ruleId",
    params: { planRows: { rows: "n_FtPlan" } },
    output: { ruleIds: { type: "array", items: { type: "string" } }, count: { type: "integer" } } },

  { kind: "fetch", id: "n_FtRule", object: "Rule", param: "rule", after: "n_KRule",
    why: "Only the credit rules those plans list - by ruleId, which already carries an index",
    fields: ["ruleId", "stage", "name", "conditions", "result", "activeStart", "activeEnd"],
    filter: [IN("properties.ruleId", KEY("n_KRule", "ruleIds")), EQ("properties.stage", "credit")] },

  { kind: "groovy", id: "n_KNeed", file: "keys-need.groovy", after: "n_FtRule", title: "What the rules still need read",
    why: "Every read left is decided HERE - a read no rule needs is a call that never happens",
    params: { ruleRows: { rows: "n_FtRule" }, attrRows: { rows: "n_FtAttr" }, payeeRows: { rows: "n_FtPayee" },
      seatCount: { int: KEY("n_KSeat", "count") } },
    output: { creditTypeCodes: { type: "array", items: { type: "string" } }, readCreditTypes: { type: "boolean" },
      territoryIds: { type: "array", items: { type: "string" } }, readTerritories: { type: "boolean" },
      currencyIds: { type: "array", items: { type: "string" } }, readCurrencies: { type: "boolean" },
      maxLevels: { type: "integer" }, readLine: { type: "boolean" } } },

  { kind: "branch", id: "n_BrRead", after: "n_KNeed", join: "n_Calc",
    why: "Only the reads the rules need, in parallel - a closed lane is a fetch that never runs",
    lanes: [
      { n: "1", name: "Territory codes", when: KEY("n_KNeed", "readTerritories"), end: "n_FtTerr" },
      { n: "2", name: "Currency codes", when: KEY("n_KNeed", "readCurrencies"), end: "n_FtCcy" },
      { n: "3", name: "Credit types", when: KEY("n_KNeed", "readCreditTypes"), end: "n_FtCT" },
      { n: "4", name: "Reporting line", when: KEY("n_KNeed", "readLine"), end: "n_FtOccUp" },
    ] },

  { kind: "fetch", id: "n_FtTerr", object: "Territory", param: "terr", after: "n_BrRead@1",
    why: "Territory codes - only when a condition reads position.territory",
    fields: ["territoryCode", "name"], filter: [IN("id", KEY("n_KNeed", "territoryIds"))] },
  { kind: "fetch", id: "n_FtCcy", object: "Currency", param: "ccy", after: "n_BrRead@2",
    why: "Currency codes - only when a condition reads payee.currency",
    fields: ["code", "name", "minorUnits"], filter: [IN("id", KEY("n_KNeed", "currencyIds"))] },
  { kind: "fetch", id: "n_FtCT", object: "CreditType", param: "ct", after: "n_BrRead@3",
    why: "Only the credit types the rules file under - a rule authors NEW_BOOKING, the column wants an id",
    fields: ["creditTypeCode", "name", "active"], filter: [IN("properties.creditTypeCode", KEY("n_KNeed", "creditTypeCodes"))] },

  // Lane 4: one hop per level the rules ask for. Each later hop sits behind a one-lane
  // branch that the previous hop's `next` flag opens, so hops the rules do not need never run.
  ...[1, 2, 3, 4].flatMap((n) => [
    ...(n === 1 ? [] : [{ kind: "branch", id: `n_BrH${n}`, after: n === 2 ? "n_KUp1" : undefined,
      join: n === 4 ? "n_KLine" : `n_BrH${n + 1}`,
      why: `Climb to level ${n} only if a rule rolls up that far and level ${n - 1} still has a parent`,
      lanes: [{ n: "1", name: `Hop ${n}`, when: KEY(`n_KUp${n - 1}`, "next"), end: `n_KUp${n}` }] }]),
    { kind: "fetch", id: `n_FtHier${n}`, object: "PositionHierarchy", param: `hier${n}`,
      after: n === 1 ? "n_BrRead@4" : `n_BrH${n}@1`,
      why: n === 1 ? "Hop 1 up the reporting line, from the crediting seats" : `Hop ${n} - only the seats hop ${n - 1} newly revealed`,
      fields: HIER_FIELDS,
      filter: [IN("properties.positionId", n === 1 ? KEY("n_KSeat", "positionIds") : KEY(`n_KUp${n - 1}`, "frontier")),
        LTE("properties.effectiveStart", S("windowEnd"))] },
    { kind: "groovy", id: `n_KUp${n}`, file: "keys-up.groovy", after: `n_FtHier${n}`, title: `Reporting line, hop ${n}`,
      why: n === 4 ? "The last hop. A rule wanting more is REFUSED, not dropped" : `Does any rule want level ${n + 1}?`,
      params: Object.assign({ seatIds: { rows: "__inline__" }, levels: { int: KEY("n_KNeed", "maxLevels") }, hop: { int: n } },
        ...Array.from({ length: n }, (_, i) => ({ [`hier${i + 1}`]: { rows: `n_FtHier${i + 1}` } }))),
      output: { frontier: { type: "array", items: { type: "string" } }, next: { type: "boolean" },
        deeper: { type: "boolean" }, ancestors: { type: "array", items: { type: "string" } }, count: { type: "integer" } } },
  ]),

  { kind: "groovy", id: "n_KLine", file: "keys-line.groovy", title: "Manager seats",
    why: "Every ancestor seat the hops that RAN revealed - between one and four of them did",
    params: Object.assign({ deeper: { bool: KEY("n_KUp4", "deeper") } },
      ...[1, 2, 3, 4].map((i) => ({ [`hier${i}`]: { rows: `n_FtHier${i}` } }))),
    output: { ancestors: { type: "array", items: { type: "string" } }, count: { type: "integer" }, deeper: { type: "boolean" } } },

  { kind: "fetch", id: "n_FtOccUp", object: "PayeePositionAssignment", param: "occUp", after: "n_KLine",
    why: "Who holds the MANAGER seats - without this every rollup finds a vacant parent",
    fields: OCC_FIELDS,
    filter: [IN("properties.positionId", KEY("n_KLine", "ancestors")), LTE("properties.effectiveStart", S("windowEnd"))] },
];

const FETCHES = STEPS.filter((s) => s.kind === "fetch");
const BRANCHES = STEPS.filter((s) => s.kind === "branch");

const calcParams = { runId: N("runId"), startedAt: N("startedAt"), dryRun: { bool: N("dryRun") },
  periodName: S("periodName"), windowStart: { int: S("windowStart") }, windowEnd: { int: S("windowEnd") },
  // The three ways a staged read can be wrong rather than slow: a key set too big for one
  // filter, and a reporting line a rule wanted climbed further than four hops.
  nameOverflow: { bool: KEY("n_KName", "overflow") },
  seatOverflow: { bool: KEY("n_KSeat", "overflow") },
  hierDeeper: { bool: KEY("n_KLine", "deeper") } };
for (const f of FETCHES) {
  calcParams[`${f.param}Rows`] = { rows: f.id };
  calcParams[`${f.param}More`] = { bool: `{{ ${f.id}.outputs.hasMore }}` };
}

/** A BRANCH, its lane nodes, and nothing else. A lane's condition lives on its
 *  BRANCH_CONDITION node; the runtime collapses that node into the edge filter. */
function branchNodes(b) {
  return [
    { context: { appName: "branch", type: "APPLICATION" }, fallbackMode: "STOP", id: b.id,
      inputs: { branches: [...b.lanes.map((l) => ({ id: l.n, inputs: { name: l.name, conditions: isTrue(l.when) } })), { id: "default" }] },
      skip: false, subTitle: b.why, title: "Branch", type: "BRANCH" },
    ...b.lanes.map((l) => ({
      context: { appName: "branch_condition", resourceName: "branch_condition", resourceVersion: 0, type: "APPLICATION" },
      fallbackMode: "STOP", id: `${b.id}@${l.n}`, inputs: { name: l.name, conditions: isTrue(l.when) },
      skip: false, title: "", type: "BRANCH_CONDITION",
    })),
  ];
}

const RESULT_SHAPE = {
  status: { type: "string" }, message: { type: "string" }, runId: { type: "string" },
  periodName: { type: "string" }, windowStart: { type: "integer" }, windowEnd: { type: "integer" },
  dryRun: { type: "boolean" }, written: { type: "integer" },
  credits: { type: "array", items: { type: "object", properties: {} } },
  exceptions: { type: "array", items: { type: "object", properties: {} } },
  stats: { type: "object", properties: {} },
};
const titled = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { ...v, title: k }]));

/** Every respond node answers the SAME shape, so a caller reads one contract whatever
 *  happened. Absent facts are "", not missing keys - a null is DROPPED from a callable's
 *  response rather than serialised, and a key that comes and goes is a caller's bug. */
const answer = (status, message, extra = {}) => ({
  status, message, runId: N("runId"), periodName: "", windowStart: 0, windowEnd: 0,
  dryRun: N("dryRun"), written: 0, credits: [], exceptions: [], stats: {}, ...extra,
});
/** An ARRAY field in a respond node's result takes the same mapped-array contract a
 *  script parameter does: a bare pill renders as unmapped, so the builder shows a caller
 *  nothing about the biggest thing this automation returns. `items` is the WHOLE element. */
const mapped = (field) => ({ "ua:type": "mappedArray", source: C(field), items: `{{ n_Calc.outputs.result.${field}[0] }}` });
const fromCalc = (status, written) => ({
  status, message: C("message"), runId: C("runId"), periodName: C("periodName"),
  windowStart: C("windowStart"), windowEnd: C("windowEnd"), dryRun: C("dryRun"),
  written, credits: mapped("credits"), exceptions: mapped("exceptions"), stats: C("stats"),
});

const nodes = [
  { context: { appName: "callables", resourceName: "callables_from_automation" }, fallbackMode: "STOP", id: "n_Start",
    inputs: {
      result: { type: "object", additionalProperties: false, required: ["status"], properties: RESULT_SHAPE },
      setup: { type: "object", additionalProperties: false, required: ["periodId"], properties: {
        periodId: { type: "string", title: "Period Id" },
        dryRun: { type: "boolean", title: "Dry Run" },
        pageLimit: { type: "integer", title: "Page Limit" },
        keyCap: { type: "integer", title: "Key Cap" },
      } },
    },
    skip: false, subTitle: "Callable - one period in, its credits out", title: "Trigger via automation",
    trigger: { type: "CALLABLE" }, type: "START" },

  groovyNode({ id: "n_Norm", title: "Normalise the request", why: "Defaults, a sentinel for an unusable period, and the run id",
    code: src("n_Norm.groovy"),
    params: { periodId: "{{ n_Start.outputs.periodId }}", dryRun: "{{ n_Start.outputs.dryRun }}",
      pageLimit: "{{ n_Start.outputs.pageLimit }}", keyCap: "{{ n_Start.outputs.keyCap }}" },
    output: titled({ periodId: { type: "string" }, inputOk: { type: "boolean" }, dryRun: { type: "boolean" },
      pageLimit: { type: "integer" }, keyCap: { type: "integer" }, runId: { type: "string" },
      startedAt: { type: "integer" } }) }),

  fetchNode({ id: "n_FtPeriod", object: "Period", title: "Fetch Period", why: "The one period this run is scoped to",
    fields: ["name", "periodType", "status", "startDate", "endDate"], filter: [EQ("id", N("periodId"))] }),

  groovyNode({ id: "n_Shape", title: "Read the period", why: "May this period be calculated, and over what window",
    code: src("n_Shape.groovy"),
    params: { periodId: N("periodId"), inputOk: { bool: N("inputOk") }, periodRows: { rows: "n_FtPeriod" } },
    output: titled({ ok: { type: "boolean" }, status: { type: "string" }, message: { type: "string" },
      periodName: { type: "string" }, windowStart: { type: "integer" }, windowEnd: { type: "integer" } }) }),

  ifNode({ id: "n_IfPer", why: "Is the period unusable?", property: S("ok"), operator: "EQUAL", value: false }),
  stopNode({ id: "n_RespPer", why: "Refuse with the reason, before a single deal is read",
    result: answer(S("status"), S("message")) }),

  ...STEPS.flatMap((st) => {
    if (st.kind === "fetch") return [fetchNode({ ...st, title: `Fetch ${st.object}` })];
    if (st.kind === "groovy") return [groovyNode({ id: st.id, title: st.title, why: st.why,
      code: src(st.file), params: st.params, output: titled(st.output) })];
    return branchNodes(st);
  }),

  groovyNode({ id: "n_Calc", title: "Calculate credits", why: "Name to seat to plan to rule to credit - the whole fold, no I/O",
    code: [src("ConditionMatcher.groovy"), src("CreditPass.groovy"), src("n_Calc.groovy")].join("\n\n"),
    params: calcParams,
    output: titled({ ...RESULT_SHAPE, expected: { type: "integer" } }) }),

  ifNode({ id: "n_IfCalc", why: "Did the fold refuse to answer?", property: C("status"), operator: "NOT_EQUAL", value: "OK" }),
  stopNode({ id: "n_RespCalc", why: "A truncated read is a wrong answer, so it is returned as one", result: fromCalc(C("status"), 0) }),

  ifNode({ id: "n_IfDry", why: "Compute and report, or actually write?", property: C("dryRun"), operator: "EQUAL", value: true }),
  stopNode({ id: "n_RespDry", why: "What WOULD be written, and every row that could not be decided", result: fromCalc("OK_DRY_RUN", 0) }),

  { context: { ...STORAGE("create_record"), resourceVersion: 864 }, fallbackMode: "STOP", id: "n_CrRun",
    inputs: { writeThroughSessionVariables: false, object_type: "CalculationRun",
      // `status` is a closed list: Running | Succeeded | Failed | Superseded. It is an
      // EXECUTION state machine, not the approval one (Draft -> Calculated -> Approved
      // -> Finalized) the design calls for - the object carries only the first.
      record: { runId: N("runId"), periodId: N("periodId"), status: "Running",
        startedAt: N("startedAt"), dryRun: false, stats: C("stats"), scope: {} } },
    options: OPTS, skip: false, subTitle: "The run the credits hang off - Running until they land",
    title: "Create record", type: "ACTION" },

  groovyNode({ id: "n_Stamp", title: "Shape the credit rows", why: "Stamp the run id and build updateFields - a flat row writes nothing",
    code: src("n_Stamp.groovy"),
    params: { runId: "{{ n_CrRun.outputs.id }}", credits: { rows: "__inline__" } },
    output: titled({ updates: { type: "array", items: { type: "object", properties: {} } }, expected: { type: "integer" } }) }),

  { context: { ...STORAGE("bulk_upsert_records_by_id"), resourceVersion: 864 }, fallbackMode: "STOP", id: "n_WrCr",
    inputs: { object_type: "Credit", skipIfBlank: false, skipSchemaValidation: true,
      updates: "{{ n_Stamp.outputs.result.updates }}", unsetIfNull: false },
    options: OPTS, skip: false, subTitle: "Every credit, by its minted id, in one call",
    title: "Bulk upsert records by id", type: "ACTION" },

  groovyNode({ id: "n_RunEnd", title: "Close the run", why: "Compare what landed against what was meant, and stamp the run with the answer",
    code: src("n_RunEnd.groovy"),
    params: { runRecordId: "{{ n_CrRun.outputs.id }}", successCount: { int: "{{ n_WrCr.outputs.successCount }}" },
              expected: { int: "{{ n_Stamp.outputs.result.expected }}" } },
    output: titled({ ok: { type: "boolean" }, landed: { type: "integer" }, message: { type: "string" },
      updates: { type: "array", items: { type: "object", properties: {} } } }) }),

  { context: { ...STORAGE("bulk_upsert_records_by_id"), resourceVersion: 864 }, fallbackMode: "STOP", id: "n_UpRun",
    inputs: { object_type: "CalculationRun", skipIfBlank: false, skipSchemaValidation: true,
      updates: "{{ n_RunEnd.outputs.result.updates }}", unsetIfNull: false },
    options: OPTS, skip: false, subTitle: "Succeeded, or Failed - by the run's own id, so no filter can miss it",
    title: "Bulk upsert records by id", type: "ACTION" },

  // `success: true` with successCount 0 is the signature of a malformed row, and a
  // bulk write can insert NOTHING and still leave the node `ok`. The count is the only
  // signal, so n_RunEnd compared it against what the fold meant to write.
  ifNode({ id: "n_IfWr", why: "Did every credit actually land?", property: "{{ n_RunEnd.outputs.result.ok }}",
    operator: "EQUAL", value: false }),
  stopNode({ id: "n_RespPart", why: "Some credits did not land - say so, with the run left Failed",
    result: { ...fromCalc("CREDIT_WRITE_INCOMPLETE", "{{ n_RunEnd.outputs.result.landed }}"),
              message: "{{ n_RunEnd.outputs.result.message }}" } }),
  stopNode({ id: "n_RespOk", why: "Credits written, run marked Succeeded",
    result: fromCalc("OK", "{{ n_RunEnd.outputs.result.landed }}") }),
];

// n_Stamp binds the fold's credits, which are a RESULT array rather than a fetch node's
// `objects`. Same mapped-array contract, different source - patched here so groovyNode
// keeps one rule about what `rows` means.
{
  const stamp = nodes.find((n) => n.id === "n_Stamp");
  stamp.inputs.parameters.credits = { "ua:type": "mappedArray", source: C("credits"), items: `{{ n_Calc.outputs.result.credits[0] }}` };

  // Key lists are arrays produced by another Groovy node's `result`, not a fetch node's
  // `objects`, so they take the same mapped-array shape with a different source. A bare
  // pill on an array-typed property works at runtime and renders as UNSET, which is how
  // a reader ends up believing a node has no inputs.
  const keyArray = (node, field) => ({ "ua:type": "mappedArray",
    source: `{{ ${node}.outputs.result.${field} }}`, items: `{{ ${node}.outputs.result.${field}[0] }}` });
  for (const n of [1, 2, 3, 4]) {
    nodes.find((x) => x.id === `n_KUp${n}`).inputs.parameters.seatIds = keyArray("n_KSeat", "positionIds");
  }
  const kasg = nodes.find((n) => n.id === "n_KAsg").inputs.parameters;
  kasg.positionIds = keyArray("n_KSeat", "positionIds");
  kasg.titleIds = keyArray("n_KTitle", "titleIds");
}

const byIdType = Object.fromEntries(nodes.map((n) => [n.id, n.type]));

const edges = [
  ["next", "n_Start", "n_Norm"],
  ["next", "n_Norm", "n_FtPeriod"],
  ["next", "n_FtPeriod", "n_Shape"],
  ["next", "n_Shape", "n_IfPer"],
  ["if", "n_IfPer", "n_RespPer"],
  // Every step declares what it comes AFTER, so the chain is derived from the
  // dependencies rather than from a hand-kept list that can silently reorder.
  ...STEPS.filter((st) => st.after).map((st) => ["next", st.after, st.id]),
  // Each branch: one edge per lane, the default edge to its join, and every lane's LAST
  // node wired to that join - the builder draws a lane without it as dangling.
  ...BRANCHES.flatMap((b) => [
    ...b.lanes.map((l) => ["branch", b.id, `${b.id}@${l.n}`, l.n]),
    ["branch", b.id, b.join, "default"],
    ...b.lanes.map((l) => ["next", l.end, b.join]),
  ]),
  ["next", "n_Calc", "n_IfCalc"],
  ["if", "n_IfCalc", "n_RespCalc"],
  ["next", "n_IfCalc", "n_IfDry"],
  ["if", "n_IfDry", "n_RespDry"],
  ["next", "n_IfDry", "n_CrRun"],
  ["next", "n_CrRun", "n_Stamp"],
  ["next", "n_Stamp", "n_WrCr"],
  ["next", "n_WrCr", "n_RunEnd"],
  ["next", "n_RunEnd", "n_UpRun"],
  ["next", "n_UpRun", "n_IfWr"],
  ["if", "n_IfWr", "n_RespPart"],
  ["next", "n_IfWr", "n_RespOk"],
].map(([type, from, to, name]) => ({
  fromNodeId: from, toNodeId: to, type,
  id: type === "branch" ? `branch@${from}@${to}` : `${type}@${from}@${to}`,
  // The canvas reads an IF edge's LABEL from `name`. The API accepts edges without one
  // and reads them straight back, so a JSON diff never catches the omission - the
  // builder just draws unlabelled forks.
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

// BFS, and where a node is reached twice keep the OUTERMOST group. The join node is
// reached once per lane plus once by the default edge; the default edge is the one
// that names where it really lives, and it is always the shallowest.
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
// An unreachable node is exactly what the builder would later drop, so refusing to
// write it is the check that catches this before a human opens the automation.
if (unreached.length) die(`unreachable from START: ${unreached.join(", ")} - fix the edges, not the groups`);

nodes.forEach((n, i) => { n.groupId = groups.get(n.id); n.index = i + 1; n.debug = false; n.dirty = false; });

// A Groovy node with code and no bound parameters is BROKEN, and a parameter has
// vanished across a definition write before with nothing reporting it.
for (const n of nodes) {
  if (n.context?.resourceName !== GROOVY.resourceName) continue;
  const p = n.inputs?.parameters ?? {};
  if (!Object.keys(p).length) die(`${n.id} has code but binds no parameters`);
  const declared = new Set(Object.keys(n.inputs.input.properties));
  for (const k of Object.keys(p)) if (!declared.has(k)) die(`${n.id} binds ${k} but does not declare it`);
}

const definition = { name: "ICM | Calculate Credits", description:
  "Turns the transactions in one period into Credit rows: a payee NAME on each deal is resolved to the seat "
  + "they held on that date, the seat's own plan is asked first and its title's plan second, and every credit "
  + "rule on the winning plan that matches fires. Dry run by default.",
  nodes, edges, settings: {}, standard: false };

const dest = path.join(ROOT, "build", "calculate-credits.json");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(definition, null, 1));
console.log(`wrote ${path.relative(ROOT, dest)}`);
console.log(`  nodes ${nodes.length}  edges ${edges.length}  groovy ${nodes.filter((n) => n.context?.resourceName === GROOVY.resourceName).length}`);
for (const n of nodes) if (n.groupId !== ROOT_GROUP) console.log(`  ${n.id.padEnd(12)} ${n.groupId}`);

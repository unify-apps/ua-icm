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
function fetchNode({ id, object, title, why, fields, filter }) {
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
  if (filter) inputs.triggerInputCondition = { operator: "AND", filters: filter };
  return { context: STORAGE("fetch_records"), fallbackMode: "STOP", id, inputs, options: OPTS, skip: false, subTitle: why, title, type: "ACTION" };
}

const EQ = (property, value) => ({ property, filter: { operator: "EQUAL", value } });
const LTE = (property, value) => ({ property, filter: { operator: "LTE", value } });
const GTE = (property, value) => ({ property, filter: { operator: "GTE", value } });

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

// One row per fetch that feeds the fold. `rows`/`more` are the two things n_Calc needs
// from each: what came back, and whether the page held all of it.
const FETCHES = [
  { id: "n_FtTxn",   object: "Transaction",             branch: 1, param: "txn",   why: "Deals whose incentive date lands in the period",
    fields: ["transactionId", "sourceId", "positionId", "closeDate", "incentiveDate", "amount", "product", "customer", "attrs"],
    filter: [GTE("properties.incentiveDate", S("windowStart")), LTE("properties.incentiveDate", S("windowEnd"))] },

  { id: "n_FtAttr",  object: "PositionAttribute",       branch: 2, param: "attr",  why: "What each seat WAS - title and territory, over a date range",
    fields: ["positionId", "titleId", "territoryId", "effectiveStart", "effectiveEnd"],
    filter: [LTE("properties.effectiveStart", S("windowEnd"))] },
  { id: "n_FtOcc",   object: "PayeePositionAssignment", branch: 2, param: "occ",   why: "Who held which seat - read both ways, by payee and by seat",
    fields: ["payeeId", "positionId", "effectiveStart", "effectiveEnd"],
    filter: [LTE("properties.effectiveStart", S("windowEnd"))] },
  { id: "n_FtHier",  object: "PositionHierarchy",       branch: 2, param: "hier",  why: "The reporting line rollup credits climb",
    fields: ["positionId", "parentPositionId", "effectiveStart", "effectiveEnd"],
    filter: [LTE("properties.effectiveStart", S("windowEnd"))] },

  { id: "n_FtAsg",   object: "PlanAssignment",          branch: 3, param: "asg",   why: "Which plan reaches which seat or title",
    fields: ["planId", "targetType", "targetId", "titleId", "positionId", "startDate", "endDate"],
    filter: [LTE("properties.startDate", S("windowEnd"))] },
  { id: "n_FtPlan",  object: "Plan",                    branch: 3, param: "plan",  why: "Every plan - status is judged in the fold, not filtered here",
    fields: ["planId", "name", "status", "startDate", "endDate", "creditRules"] },
  { id: "n_FtRule",  object: "Rule",                    branch: 3, param: "rule",  why: "Credit rules only - the payout pass reads the others",
    fields: ["ruleId", "stage", "name", "conditions", "result", "activeStart", "activeEnd"],
    filter: [EQ("properties.stage", "credit")] },

  { id: "n_FtPayee", object: "Payee",                   branch: 4, param: "payee", why: "Every payee - a name on a deal is resolved against these",
    fields: ["employeeId", "name", "currencyId", "hireDate", "terminationDate", "status"] },
  { id: "n_FtTitle", object: "Title",                   branch: 4, param: "title", why: "Title CODES - a rule stores T-AE, the seat stores a record id",
    fields: ["titleCode", "name"] },
  { id: "n_FtTerr",  object: "Territory",               branch: 4, param: "terr",  why: "Territory codes, for position.territory",
    fields: ["territoryCode", "name"] },
  { id: "n_FtCcy",   object: "Currency",                branch: 4, param: "ccy",   why: "Currency codes, for payee.currency",
    fields: ["code", "name", "minorUnits"] },
  { id: "n_FtPos",   object: "Position",                branch: 4, param: "pos",   why: "Position codes - plan assignments name seats both ways",
    fields: ["positionCode", "name", "active"] },
  { id: "n_FtCT",    object: "CreditType",              branch: 4, param: "ct",    why: "Credit type codes - a rule authors NEW_BOOKING, the column wants an id",
    fields: ["creditTypeCode", "name", "active"] },
];

const BRANCHES = [
  { id: "1", name: "Deals" },
  { id: "2", name: "Seat facts" },
  { id: "3", name: "Plan config" },
  { id: "4", name: "Reference data" },
];

const calcParams = { runId: N("runId"), startedAt: N("startedAt"), dryRun: { bool: N("dryRun") },
  periodName: S("periodName"), windowStart: { int: S("windowStart") }, windowEnd: { int: S("windowEnd") } };
for (const f of FETCHES) {
  calcParams[`${f.param}Rows`] = { rows: f.id };
  calcParams[`${f.param}More`] = { bool: `{{ ${f.id}.outputs.hasMore }}` };
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
      } },
    },
    skip: false, subTitle: "Callable - one period in, its credits out", title: "Trigger via automation",
    trigger: { type: "CALLABLE" }, type: "START" },

  groovyNode({ id: "n_Norm", title: "Normalise the request", why: "Defaults, a sentinel for an unusable period, and the run id",
    code: src("n_Norm.groovy"),
    params: { periodId: "{{ n_Start.outputs.periodId }}", dryRun: "{{ n_Start.outputs.dryRun }}", pageLimit: "{{ n_Start.outputs.pageLimit }}" },
    output: titled({ periodId: { type: "string" }, inputOk: { type: "boolean" }, dryRun: { type: "boolean" },
      pageLimit: { type: "integer" }, runId: { type: "string" }, startedAt: { type: "integer" } }) }),

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

  { context: { appName: "branch", type: "APPLICATION" }, fallbackMode: "STOP", id: "n_Br",
    // Four lanes, no conditions on any of them: an edge with NO filter is ALWAYS
    // applicable, which is what turns this into an unconditional parallel fan-out.
    // Sequentially these twelve fetches pay 12x latency for nothing.
    inputs: { branches: [...BRANCHES.map((b) => ({ id: b.id, inputs: { name: b.name } })), { id: "default" }] },
    skip: false, subTitle: "Read every object once, in parallel", title: "Branch", type: "BRANCH" },

  ...BRANCHES.map((b) => ({
    context: { appName: "branch_condition", resourceName: "branch_condition", resourceVersion: 0, type: "APPLICATION" },
    fallbackMode: "STOP", id: `n_Br@${b.id}`, inputs: { name: b.name }, skip: false, title: "", type: "BRANCH_CONDITION",
  })),

  ...FETCHES.map((f) => fetchNode({ ...f, title: `Fetch ${f.object}` })),

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
}

const byIdType = Object.fromEntries(nodes.map((n) => [n.id, n.type]));

const edges = [
  ["next", "n_Start", "n_Norm"],
  ["next", "n_Norm", "n_FtPeriod"],
  ["next", "n_FtPeriod", "n_Shape"],
  ["next", "n_Shape", "n_IfPer"],
  ["if", "n_IfPer", "n_RespPer"],
  ["next", "n_IfPer", "n_Br"],
  ...BRANCHES.map((b) => ["branch", "n_Br", `n_Br@${b.id}`, b.id]),
  ["branch", "n_Br", "n_Calc", "default"],
  ...BRANCHES.flatMap((b) => {
    const lane = FETCHES.filter((f) => String(f.branch) === b.id);
    const chain = [`n_Br@${b.id}`, ...lane.map((f) => f.id), "n_Calc"];
    return chain.slice(0, -1).map((from, i) => ["next", from, chain[i + 1]]);
  }),
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

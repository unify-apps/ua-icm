#!/usr/bin/env node
// Assemble the `ICM | Update Position` definition from the Groovy in
// automations/update-position/ and the graph declared below.
//
//   node scripts/build-update-position.mjs        # write build/update-position.json
//
// Then: lint.mjs --file build/update-position.json, ua-automation.mjs plan|create --env tool,
// ua.mjs validate, regress.mjs. Spec: docs/automations/update-position.md.
//
// A builder rather than hand-written JSON for the reason build-calculate-credits.mjs gives:
// `groupId` is what the BUILDER draws the tree from, a graph with wrong groups still
// executes, and re-serialising it in the builder silently drops the nodes it cannot place.
// So groups are DERIVED by walking the edges from START, and an unreachable node is fatal.
//
// The node helpers are copied from that builder, not imported. Two builders do not yet
// justify a shared module; the third should extract them.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "automations", "update-position");
const src = (f) => fs.readFileSync(path.join(SRC, f), "utf8");
const die = (m) => { console.error(`error: ${m}`); process.exit(1); };

/** Dated rows read per position. More than this is refused, never planned from a prefix. */
const HISTORY_LIMIT = 500;

// ---------------------------------------------------------------- node helpers
const STORAGE = (resourceName) => ({ appName: "storage_by_unifyapps", resourceName: `storage_by_unifyapps_${resourceName}`, type: "APPLICATION" });
const GROOVY = { appName: "code_by_unifyapps", resourceName: "code_by_unifyapps_groovy", type: "APPLICATION" };
const OPTS = { disableLogging: false, enabledForReExecution: false, stepError: "STOP" };

const EQ = (property, value) => ({ property, filter: { operator: "EQUAL", value } });
const IN = (property, value) => ({ property, filter: { operator: "IN", value } });

function fetchNode({ id, object, why, fields, filter, limit }) {
  return {
    context: STORAGE("fetch_records"), fallbackMode: "STOP", id,
    inputs: {
      shouldSearchInAnalyticsStore: false, object_type: object, includeRoleMappings: false,
      includeCurrentUserPermissions: false, translationsOption: "DEFAULT",
      page: { paginateBy: "OFFSET", limit, offset: 0 },
      numberOfRecordsToFetch: "MULTIPLE", includeTotalCount: true, readThroughSessionVariables: false,
      fields: ["id", ...fields.map((f) => `properties.${f}`)],
      // A STRUCTURED tree, never a whole-value template: the builder's filter editor can
      // draw one and the missing-index analyser can read one.
      triggerInputCondition: { operator: "AND", filters: filter },
    },
    options: OPTS, skip: false, subTitle: why, title: "Fetch records", type: "ACTION",
  };
}

/** `parameters` BINDS; `input` is what the builder draws. Generated from one list so they cannot disagree. */
function groovyNode({ id, title, why, code, params, output }) {
  const properties = {};
  const parameters = {};
  for (const [name, spec] of Object.entries(params)) {
    if (typeof spec === "string") {
      properties[name] = { type: "string", title: name };
      parameters[name] = spec;
    } else if (spec.rows) {
      // `items` is the WHOLE element: mapping to `.properties` strips `id`.
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
  // appName `if_else`, resourceName `if_else_condition` - the other way round RUNS but
  // renders as "no actions found" in the builder.
  context: { appName: "if_else", resourceName: "if_else_condition", type: "APPLICATION" },
  fallbackMode: "STOP", id,
  // filters at the TOP level of inputs; wrapped, the condition is silently FALSE
  inputs: { filters: [{ property, filter: { operator, value } }], operator: "AND" },
  skip: false, subTitle: why, title: "Condition", type: "IF_ELSE",
});

const stopNode = ({ id, why, result }) => ({
  context: { appName: "callables", resourceName: "callables_return_to_automation", type: "APPLICATION" },
  fallbackMode: "STOP", id, inputs: { result }, skip: false, subTitle: why,
  title: "Respond to automation", type: "STOP",
});

const upsertNode = ({ id, object, updates, why }) => ({
  context: { ...STORAGE("bulk_upsert_records_by_id"), resourceVersion: 864 }, fallbackMode: "STOP", id,
  // An EMPTY `updates` is a harmless no-op (runtime-facts, 2026-08-25), which is what lets
  // every write node run unconditionally instead of sitting behind its own IF.
  inputs: { object_type: object, skipIfBlank: false, skipSchemaValidation: true, updates, unsetIfNull: false },
  options: OPTS, skip: false, subTitle: why, title: "Bulk upsert records by id", type: "ACTION",
});

const titled = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { ...v, title: k }]));

// ------------------------------------------------------------------- the graph
const N = (k) => `{{ n_Norm.outputs.result.${k} }}`;
const P = (k) => `{{ n_Plan.outputs.result.${k} }}`;
const D = (k) => `{{ n_Done.outputs.result.${k} }}`;

const RESULT_SHAPE = {
  status: { type: "string" }, success: { type: "boolean" }, message: { type: "string" },
  positionId: { type: "string" }, positionCode: { type: "string" },
  changedFields: { type: "array", items: { type: "string" } },
  titleChanged: { type: "boolean" }, personChanged: { type: "boolean" },
  attributeId: { type: "string" }, assignmentId: { type: "string" },
  effectiveStart: { type: "string" },
};

/** Every respond node answers the SAME keys. A null is DROPPED from a callable's response,
 *  so absent facts go back as "" / false / [], never as a missing key. */
const answer = (status, message, extra = {}) => ({
  status, success: false, message, positionId: N("positionId"), positionCode: "",
  changedFields: [], titleChanged: false, personChanged: false,
  attributeId: "", assignmentId: "", effectiveStart: N("effDay"), ...extra,
});
const fromPlan = {
  positionCode: P("positionCode"),
  // an array in a respond result needs the mapped-array contract; a bare pill renders unset
  changedFields: { "ua:type": "mappedArray", source: P("changedFields"), items: "{{ n_Plan.outputs.result.changedFields[0] }}" },
  titleChanged: P("titleChanged"), personChanged: P("personChanged"),
  attributeId: P("attributeId"), assignmentId: P("assignmentId"),
};

const DATED_FIELDS = ["name", "positionId", "effectiveStart", "effectiveEnd"];
const flag = (k) => ({ bool: N(k) });

const nodes = [
  { context: { appName: "callables", resourceName: "callables_from_automation" }, fallbackMode: "STOP", id: "n_Start",
    inputs: {
      result: { type: "object", additionalProperties: false, required: ["status", "success", "message"], properties: titled(RESULT_SHAPE) },
      // Nothing is required at the schema level: blank means "leave alone" for every
      // field, and n_Norm refuses a request that names nothing, with its own message.
      setup: { type: "object", additionalProperties: false, required: [], properties: titled({
        positionId: { type: "string" }, name: { type: "string" }, titleId: { type: "string" },
        payeeId: { type: "string" }, clearPayee: { type: "string" }, active: { type: "string" },
        effectiveStart: { type: "string" },
      }) },
    },
    skip: false, subTitle: "Callable - one position's edit in, what changed out", title: "Trigger via automation",
    trigger: { type: "CALLABLE" }, type: "START" },

  groovyNode({ id: "n_Norm", title: "Groovy code", why: "Validate the request and settle the effective date",
    code: src("n_Norm.groovy"),
    params: Object.fromEntries(["positionId", "name", "titleId", "payeeId", "clearPayee", "active", "effectiveStart"]
      .map((k) => [k, `{{ n_Start.outputs.${k} }}`])),
    output: titled({ valid: { type: "boolean" }, reason: { type: "string" }, positionId: { type: "string" },
      name: { type: "string" }, titleId: { type: "string" }, payeeId: { type: "string" },
      clearPayee: { type: "boolean" }, active: { type: "boolean" },
      wantName: { type: "boolean" }, wantActive: { type: "boolean" }, wantTitle: { type: "boolean" }, wantPerson: { type: "boolean" },
      effEpoch: { type: "integer" }, effDay: { type: "string" },
      positionKey: { type: "string" }, titleKey: { type: "string" }, payeeKey: { type: "string" } }) }),

  ifNode({ id: "n_IfBad", why: "Was the request itself unusable?", property: N("valid"), operator: "EQUAL", value: false }),
  stopNode({ id: "n_StBad", why: "Caller sent something that could not be written - nothing was read or written",
    result: answer("INVALID_INPUT", N("reason")) }),

  fetchNode({ id: "n_FtPos", object: "Position", why: "The position being edited, read before anything is written",
    fields: ["positionCode", "name", "active"], filter: [EQ("id", N("positionKey"))], limit: 1 }),
  fetchNode({ id: "n_FtAttr", object: "PositionAttribute", why: "Every dated title row of this position, to find the one in force",
    fields: [...DATED_FIELDS, "titleId", "territoryId"], filter: [EQ("properties.positionId", N("positionKey"))], limit: HISTORY_LIMIT }),
  fetchNode({ id: "n_FtAsg", object: "PayeePositionAssignment", why: "Every dated assignment of this position, to find who holds it",
    fields: [...DATED_FIELDS, "payeeId", "allocationPct"], filter: [EQ("properties.positionId", N("positionKey"))], limit: HISTORY_LIMIT }),
  fetchNode({ id: "n_FtTitle", object: "Title", why: "Does the requested title exist? A no-match when none was named",
    fields: ["titleCode", "name"], filter: [EQ("id", N("titleKey"))], limit: 1 }),
  fetchNode({ id: "n_FtPayee", object: "Payee", why: "Does the requested person exist? A no-match when none was named",
    fields: ["employeeId", "name"], filter: [EQ("id", N("payeeKey"))], limit: 1 }),

  groovyNode({ id: "n_Plan", title: "Plan the writes", why: "Refuse or decide every row to write, from what is stored now",
    code: src("n_Plan.groovy"),
    params: {
      posRows: { rows: "n_FtPos" }, attrRows: { rows: "n_FtAttr" }, asgRows: { rows: "n_FtAsg" },
      titleRows: { rows: "n_FtTitle" }, payeeRows: { rows: "n_FtPayee" },
      attrMore: { bool: "{{ n_FtAttr.outputs.hasMore }}" }, asgMore: { bool: "{{ n_FtAsg.outputs.hasMore }}" },
      historyLimit: { int: HISTORY_LIMIT },
      positionId: N("positionId"), name: N("name"), titleId: N("titleId"), payeeId: N("payeeId"),
      clearPayee: flag("clearPayee"), active: flag("active"),
      wantName: flag("wantName"), wantActive: flag("wantActive"), wantTitle: flag("wantTitle"), wantPerson: flag("wantPerson"),
      effEpoch: { int: N("effEpoch") }, effDay: N("effDay"),
    },
    output: titled({ ok: { type: "boolean" }, status: { type: "string" }, message: { type: "string" },
      positionCode: { type: "string" },
      posUpdates: { type: "array", items: { type: "object", properties: {} } },
      attrUpdates: { type: "array", items: { type: "object", properties: {} } },
      asgUpdates: { type: "array", items: { type: "object", properties: {} } },
      deleteIds: { type: "array", items: { type: "string" } },
      posExpected: { type: "integer" }, attrExpected: { type: "integer" },
      asgExpected: { type: "integer" }, delExpected: { type: "integer" },
      changedFields: { type: "array", items: { type: "string" } },
      titleChanged: { type: "boolean" }, personChanged: { type: "boolean" },
      attributeId: { type: "string" }, assignmentId: { type: "string" } }) }),

  ifNode({ id: "n_IfBlk", why: "Did a check refuse the edit?", property: P("ok"), operator: "EQUAL", value: false }),
  stopNode({ id: "n_StBlk", why: "Refused before writing anything", result: answer(P("status"), P("message"), { positionCode: P("positionCode") }) }),

  // Ordered for recoverability: the seat, then its dated rows. Every plan is re-derived
  // from the store, so a retry after a partial failure writes only what did not land.
  upsertNode({ id: "n_WrPos", object: "Position", updates: P("posUpdates"), why: "The seat's own name and active flag" }),
  upsertNode({ id: "n_WrAttr", object: "PositionAttribute", updates: P("attrUpdates"), why: "Close the title row in force and open the new one" }),
  upsertNode({ id: "n_WrAsg", object: "PayeePositionAssignment", updates: P("asgUpdates"), why: "Close the assignment in force and open the new one" }),

  { context: STORAGE("delete_records"), fallbackMode: "STOP", id: "n_DelAsg",
    inputs: {
      object_type: "PayeePositionAssignment", numberOfRecordsToDelete: "MULTIPLE", writeThroughSessionVariables: false,
      // A '__none__' IN matches nothing and is a no-op (runtime-facts, 2026-08-25).
      triggerInputCondition: { operator: "AND", filters: [IN("id", P("deleteIds"))] },
      page: { limit: 10, offset: 0 },
    },
    options: OPTS, skip: false, subTitle: "Remove an assignment emptied on the day it started", title: "Delete records", type: "ACTION" },

  groovyNode({ id: "n_Done", title: "Check the writes", why: "Compare what landed against what was planned",
    code: src("n_Done.groovy"),
    params: {
      posCount: { int: "{{ n_WrPos.outputs.successCount }}" }, posExpected: { int: P("posExpected") },
      attrCount: { int: "{{ n_WrAttr.outputs.successCount }}" }, attrExpected: { int: P("attrExpected") },
      asgCount: { int: "{{ n_WrAsg.outputs.successCount }}" }, asgExpected: { int: P("asgExpected") },
      delCount: { int: "{{ n_DelAsg.outputs.count }}" }, delExpected: { int: P("delExpected") },
    },
    output: titled({ ok: { type: "boolean" }, message: { type: "string" } }) }),

  ifNode({ id: "n_IfWr", why: "Did every planned write land?", property: D("ok"), operator: "EQUAL", value: false }),
  stopNode({ id: "n_StPart", why: "Some writes did not land - say which, never report success",
    result: answer("WRITE_INCOMPLETE", D("message"), fromPlan) }),
  stopNode({ id: "n_StOk", why: "What was written",
    result: answer("OK", P("message"), { ...fromPlan, success: true }) }),
];

const byIdType = Object.fromEntries(nodes.map((n) => [n.id, n.type]));

const edges = [
  ["next", "n_Start", "n_Norm"],
  ["next", "n_Norm", "n_IfBad"],
  ["if", "n_IfBad", "n_StBad"],
  ["next", "n_IfBad", "n_FtPos"],
  ["next", "n_FtPos", "n_FtAttr"],
  ["next", "n_FtAttr", "n_FtAsg"],
  ["next", "n_FtAsg", "n_FtTitle"],
  ["next", "n_FtTitle", "n_FtPayee"],
  ["next", "n_FtPayee", "n_Plan"],
  ["next", "n_Plan", "n_IfBlk"],
  ["if", "n_IfBlk", "n_StBlk"],
  ["next", "n_IfBlk", "n_WrPos"],
  ["next", "n_WrPos", "n_WrAttr"],
  ["next", "n_WrAttr", "n_WrAsg"],
  ["next", "n_WrAsg", "n_DelAsg"],
  ["next", "n_DelAsg", "n_Done"],
  ["next", "n_Done", "n_IfWr"],
  ["if", "n_IfWr", "n_StPart"],
  ["next", "n_IfWr", "n_StOk"],
].map(([type, from, to]) => ({
  fromNodeId: from, toNodeId: to, type, id: `${type}@${from}@${to}`,
  // the canvas labels an IF edge from `name`; without it the builder draws unlabelled forks
  ...(byIdType[from] === "IF_ELSE" ? { name: type === "if" ? "yes" : "no" } : {}),
  priority: 0, skip: false,
}));

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
    const child = node.type === "IF_ELSE" ? `${id}@${g}@${e.type === "if" ? "y" : "n"}` : g;
    const seen = groups.get(e.toNodeId);
    if (seen !== undefined && depth(seen) <= depth(child)) continue;
    groups.set(e.toNodeId, child);
    queue.push(e.toNodeId);
  }
}

const unreached = nodes.filter((n) => !groups.has(n.id)).map((n) => n.id);
if (unreached.length) die(`unreachable from START: ${unreached.join(", ")} - fix the edges, not the groups`);
nodes.forEach((n, i) => { n.groupId = groups.get(n.id); n.index = i + 1; n.debug = false; n.dirty = false; });

// A Groovy node whose code reads a parameter it does not bind dies at run time.
for (const n of nodes) {
  if (n.context?.resourceName !== GROOVY.resourceName) continue;
  const p = n.inputs?.parameters ?? {};
  if (!Object.keys(p).length) die(`${n.id} has code but binds no parameters`);
  const declared = new Set(Object.keys(n.inputs.input.properties));
  for (const k of Object.keys(p)) if (!declared.has(k)) die(`${n.id} binds ${k} but does not declare it`);
}

const definition = {
  name: "ICM | Update Position",
  description:
    "Edits one position: its name and active flag in place, and its title and occupant as DATED changes - the row "
    + "in force is closed the millisecond before the effective date and a new one opens from it, so past periods keep "
    + "resolving to what was true then. A change dated the day a row opened corrects that row instead. Every check runs "
    + "before the first write, and the same request sent twice changes nothing the second time.",
  nodes, edges, settings: {}, standard: false,
};

const dest = path.join(ROOT, "build", "update-position.json");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(definition, null, 1));
console.log(`wrote ${path.relative(ROOT, dest)}`);
console.log(`  nodes ${nodes.length}  edges ${edges.length}`);
for (const n of nodes) if (n.groupId !== ROOT_GROUP) console.log(`  ${n.id.padEnd(10)} ${n.groupId}`);

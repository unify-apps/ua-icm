#!/usr/bin/env node
// Assemble the `ICM | Bulk Manage Positions` definition from the Groovy in
// automations/bulk-manage-positions/ and the graph declared below.
//
//   node scripts/build-bulk-manage-positions.mjs     # write build/bulk-manage-positions.json
//
// Then: lint.mjs --file, ua-automation.mjs plan|create --env tool, ua.mjs validate,
// regress.mjs. Spec: docs/automations/bulk-manage-positions.md.
//
// Same reason for a builder as build-update-position.mjs: `groupId` is DERIVED from the
// edges, never typed, because a graph with wrong groups runs and then loses nodes the
// first time the builder re-saves it. This one adds the LOOP shape, copied from
// `ICM | Bulk Manage Titles` rather than guessed: a `loop` edge into the body, the body in
// group `<loop>@<parent>@l`, and a `next` edge named `loopback` from the body's last node.
//
// Helpers are copied from build-update-position.mjs. This is the third builder, and the
// note there says the third should extract them - that is a separate change, made once
// the three have been compared, not squeezed into this one.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "automations", "bulk-manage-positions");
const src = (f) => fs.readFileSync(path.join(SRC, f), "utf8");
const die = (m) => { console.error(`error: ${m}`); process.exit(1); };

/** Rows one file may carry. Bounded so a plan never runs on a fetch that was truncated. */
const MAX_ROWS = 2000;
/** One page per keyed read. More stored matches than this is REFUSED, never planned from a prefix. */
const READ_LIMIT = 5000;
/** Big enough that any file under MAX_ROWS is one batch - the plan must see the whole file at once. */
const LOOP_BATCH = 100000;
/** The loop reads the file by these header names; the app's template writes exactly these. */
const COLUMNS = ["position_code", "name", "title_code", "employee_id", "effective_start"];

// ---------------------------------------------------------------- node helpers
const STORAGE = (resourceName) => ({ appName: "storage_by_unifyapps", resourceName: `storage_by_unifyapps_${resourceName}`, type: "APPLICATION" });
const GROOVY = { appName: "code_by_unifyapps", resourceName: "code_by_unifyapps_groovy", type: "APPLICATION" };
const OPTS = { disableLogging: false, enabledForReExecution: false, stepError: "STOP" };
const IN = (property, value) => ({ property, filter: { operator: "IN", value } });

function fetchNode({ id, object, why, fields, filter }) {
  const inputs = {
    shouldSearchInAnalyticsStore: false, object_type: object, includeRoleMappings: false,
    includeCurrentUserPermissions: false, translationsOption: "DEFAULT",
    page: { paginateBy: "OFFSET", limit: READ_LIMIT, offset: 0 },
    numberOfRecordsToFetch: "MULTIPLE", includeTotalCount: true, readThroughSessionVariables: false,
    fields: ["id", ...fields.map((f) => `properties.${f}`)],
  };
  // a STRUCTURED tree, never a whole-value template: the builder can draw it and the
  // missing-index analyser can read it
  if (filter) inputs.triggerInputCondition = { operator: "AND", filters: filter };
  return { context: STORAGE("fetch_records"), fallbackMode: "STOP", id, inputs, options: OPTS, skip: false, subTitle: why, title: "Fetch records", type: "ACTION" };
}

const mapped = (source, first) => ({ "ua:type": "mappedArray", source, items: first });

/** `parameters` BINDS; `input` is what the builder draws. Generated from one list so they cannot disagree. */
function groovyNode({ id, title, why, code, params, output }) {
  const properties = {};
  const parameters = {};
  for (const [name, spec] of Object.entries(params)) {
    if (typeof spec === "string") {
      properties[name] = { type: "string", title: name };
      parameters[name] = spec;
    } else if (spec.rows) {
      // a fetch node's objects; `items` is the WHOLE element, or `id` is stripped
      properties[name] = { type: "array", title: name, items: { type: "object", properties: {}, additionalProperties: false } };
      parameters[name] = mapped(`{{ ${spec.rows}.outputs.objects }}`, `{{ ${spec.rows}.outputs.objects[0] }}`);
    } else if (spec.result) {
      // an array another Groovy node returned; a bare pill renders as UNSET in the builder
      const [node, field] = spec.result;
      properties[name] = { type: "array", title: name, items: { type: "object", properties: {}, additionalProperties: false } };
      parameters[name] = mapped(`{{ ${node}.outputs.result.${field} }}`, `{{ ${node}.outputs.result.${field}[0] }}`);
    } else if (spec.loopItem) {
      // the batch the loop hands over - bound exactly as Bulk Manage Titles binds it
      properties[name] = { type: "array", title: name };
      parameters[name] = spec.loopItem;
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

const upsertNode = ({ id, object, updates, why }) => ({
  context: { ...STORAGE("bulk_upsert_records_by_id"), resourceVersion: 864 }, fallbackMode: "STOP", id,
  // an EMPTY `updates` is a harmless no-op (runtime-facts, 2026-08-25): a dry run, a
  // refused file and an all-unchanged file all pass straight through
  inputs: { object_type: object, skipIfBlank: false, skipSchemaValidation: true, updates, unsetIfNull: false },
  options: OPTS, skip: false, subTitle: why, title: "Bulk upsert records by id", type: "ACTION",
});

const titled = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { ...v, title: k }]));
const arr = (items = { type: "object", properties: {} }) => ({ type: "array", items });

// ------------------------------------------------------------------- the graph
const K = (f) => `{{ n_Keys.outputs.result.${f} }}`;
const P = (f) => `{{ n_Plan.outputs.result.${f} }}`;
const D = (f) => `{{ n_Done.outputs.result.${f} }}`;
const F = (f) => `{{ n_Final.outputs.result.${f} }}`;
const more = (node) => ({ bool: `{{ ${node}.outputs.hasMore }}` });

const ROW_SHAPE = titled({
  line: { type: "integer" }, outcome: { type: "string" }, error: { type: "string" },
  ...Object.fromEntries(COLUMNS.map((c) => [c, { type: "string" }])),
});

const nodes = [
  { context: { appName: "callables", resourceName: "callables_from_automation" }, fallbackMode: "STOP", id: "n_Start",
    inputs: {
      // Same three inputs and same answer as Bulk Manage Titles / People, so the app's
      // shared useBulkUpload and BulkUploadDialog serve Positions unchanged.
      result: { type: "object", additionalProperties: false, required: ["status"], properties: titled({
        status: { type: "string" }, batchId: { type: "string" }, applied: { type: "integer" },
        written: { type: "integer" }, message: { type: "string" },
        rows: { type: "array", items: { type: "object", properties: ROW_SHAPE } },
      }) },
      setup: { type: "object", additionalProperties: false, required: [], properties: {
        fileDetails: { title: "File", type: "object", additionalProperties: false, properties: {} },
        batchId: { title: "Batch Id", type: "string" },
        dryRun: { title: "Dry Run", type: "string" },
      } },
    },
    skip: false, subTitle: "Callable - one CSV of positions in, a verdict per row out", title: "Trigger via automation",
    trigger: { type: "CALLABLE" }, type: "START" },

  // The title catalog is reference data that does not grow with the file, and a code is
  // matched case-insensitively, which an IN filter cannot do - so it is read whole, once.
  fetchNode({ id: "n_FtTitle", object: "Title", why: "The title catalog, to resolve title codes",
    fields: ["titleCode", "name"] }),

  { context: { appName: "csv_by_unifyapps", resourceVersion: 27, resourceName: "csv_by_unifyapps_for_each_row_or_rows", type: "APPLICATION" },
    fallbackMode: "STOP", id: "n_Loop",
    inputs: { startFromRow: 1, file: "{{ n_Start.outputs.fileDetails }}", headerRow: true, columns: COLUMNS,
      batch: true, batchSize: LOOP_BATCH, fileType: "csv" },
    skip: false, subTitle: "Read the whole file in one batch", title: "Read the uploaded CSV, row by row", type: "LOOP" },

  groovyNode({ id: "n_Keys", title: "Groovy code", why: "Normalise the file and collect the codes and employee ids it names",
    code: src("n_Keys.groovy"), params: { rows: { loopItem: "{{ n_Loop.outputs.item }}" } },
    output: titled({ clean: arr(), rowCount: { type: "integer" }, missingColumns: arr({ type: "string" }),
      codes: arr({ type: "string" }), employeeIds: arr({ type: "string" }) }) }),

  fetchNode({ id: "n_FtPos", object: "Position", why: "Only the positions this file names - by code, not the whole org",
    fields: ["positionCode", "name", "active"], filter: [IN("properties.positionCode", K("codes"))] }),
  fetchNode({ id: "n_FtPay", object: "Payee", why: "Only the people this file names - by employee id",
    fields: ["employeeId", "name"], filter: [IN("properties.employeeId", K("employeeIds"))] }),

  groovyNode({ id: "n_KPos", title: "Groovy code", why: "The ids of the positions that already exist, to key the dated reads",
    code: src("n_KPos.groovy"), params: { posRows: { rows: "n_FtPos" } },
    output: titled({ positionIds: arr({ type: "string" }) }) }),

  fetchNode({ id: "n_FtAttr", object: "PositionAttribute", why: "The title rows of those positions, to see what is in force",
    fields: ["name", "positionId", "titleId", "effectiveStart", "effectiveEnd"],
    filter: [IN("properties.positionId", "{{ n_KPos.outputs.result.positionIds }}")] }),
  fetchNode({ id: "n_FtAsg", object: "PayeePositionAssignment", why: "The assignments of those positions, to see who holds them",
    fields: ["name", "payeeId", "positionId", "effectiveStart", "effectiveEnd"],
    filter: [IN("properties.positionId", "{{ n_KPos.outputs.result.positionIds }}")] }),

  groovyNode({ id: "n_Plan", title: "Plan the writes", why: "Judge every row against what is stored, and plan the writes",
    code: src("n_Plan.groovy"),
    params: {
      rows: { result: ["n_Keys", "clean"] }, missingColumns: { result: ["n_Keys", "missingColumns"] },
      titleRows: { rows: "n_FtTitle" }, posRows: { rows: "n_FtPos" }, payeeRows: { rows: "n_FtPay" },
      attrRows: { rows: "n_FtAttr" }, asgRows: { rows: "n_FtAsg" },
      titleMore: more("n_FtTitle"), posMore: more("n_FtPos"), payMore: more("n_FtPay"),
      attrMore: more("n_FtAttr"), asgMore: more("n_FtAsg"),
      maxRows: { int: MAX_ROWS }, dryRun: "{{ n_Start.outputs.dryRun }}",
    },
    output: titled({ status: { type: "string" }, message: { type: "string" }, rows: arr(),
      applied: { type: "integer" }, writtenRows: { type: "integer" },
      posUpdates: arr(), attrUpdates: arr(), asgUpdates: arr(),
      posExpected: { type: "integer" }, attrExpected: { type: "integer" }, asgExpected: { type: "integer" } }) }),

  // Positions first, then the dated rows that point at them. Every id is minted from the
  // business key, so re-uploading after a failure rewrites the same records.
  upsertNode({ id: "n_WrPos", object: "Position", updates: P("posUpdates"), why: "Every new or renamed position, in one call" }),
  upsertNode({ id: "n_WrAttr", object: "PositionAttribute", updates: P("attrUpdates"), why: "Every title row the file opens, in one call" }),
  upsertNode({ id: "n_WrAsg", object: "PayeePositionAssignment", updates: P("asgUpdates"), why: "Every assignment the file opens, in one call" }),

  groovyNode({ id: "n_Done", title: "Check the writes", why: "Compare what landed against what was planned",
    code: src("n_Done.groovy"),
    params: {
      posCount: { int: "{{ n_WrPos.outputs.successCount }}" }, posExpected: { int: P("posExpected") },
      attrCount: { int: "{{ n_WrAttr.outputs.successCount }}" }, attrExpected: { int: P("attrExpected") },
      asgCount: { int: "{{ n_WrAsg.outputs.successCount }}" }, asgExpected: { int: P("asgExpected") },
      planStatus: P("status"), planMessage: P("message"), writtenRows: { int: P("writtenRows") },
    },
    output: titled({ status: { type: "string" }, message: { type: "string" }, written: { type: "integer" } }) }),

  // After the loop, not inside it: a header-only file never runs the body, and this is
  // what still answers it with a status and a reason.
  groovyNode({ id: "n_Final", title: "Groovy code", why: "The answer - including for a file the loop never entered",
    code: src("n_Final.groovy"),
    params: {
      status: D("status"), message: D("message"), written: { int: D("written") },
      applied: { int: P("applied") }, rows: { result: ["n_Plan", "rows"] },
    },
    output: titled({ status: { type: "string" }, message: { type: "string" }, applied: { type: "integer" },
      written: { type: "integer" }, rows: arr() }) }),

  { context: { appName: "callables", resourceName: "callables_return_to_automation", type: "APPLICATION" },
    fallbackMode: "STOP", id: "n_StDone",
    inputs: { result: {
      status: F("status"), batchId: "{{ n_Start.outputs.batchId }}", applied: F("applied"), written: F("written"),
      rows: mapped(F("rows"), "{{ n_Final.outputs.result.rows[0] }}"), message: F("message"),
    } },
    skip: false, subTitle: "Every row, with what happened to it", title: "Respond to automation", type: "STOP" },
];

const edges = [
  ["next", "n_Start", "n_FtTitle"],
  ["next", "n_FtTitle", "n_Loop"],
  ["loop", "n_Loop", "n_Keys"],
  ["next", "n_Keys", "n_FtPos"],
  ["next", "n_FtPos", "n_FtPay"],
  ["next", "n_FtPay", "n_KPos"],
  ["next", "n_KPos", "n_FtAttr"],
  ["next", "n_FtAttr", "n_FtAsg"],
  ["next", "n_FtAsg", "n_Plan"],
  ["next", "n_Plan", "n_WrPos"],
  ["next", "n_WrPos", "n_WrAttr"],
  ["next", "n_WrAttr", "n_WrAsg"],
  ["next", "n_WrAsg", "n_Done"],
  ["next", "n_Done", "n_Loop", "loopback"],
  ["next", "n_Loop", "n_Final"],
  ["next", "n_Final", "n_StDone"],
].map(([type, from, to, name]) => ({
  fromNodeId: from, toNodeId: to, type, id: `${type}@${from}@${to}`,
  ...(name ? { name } : {}), priority: 0, skip: false,
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
    // the loop body lives one level in; the loopback and the exit stay where they are,
    // and keeping the SHALLOWER group on a revisit is what stops the loopback re-homing it
    const child = node.type === "LOOP" && e.type === "loop" ? `${id}@${g}@l` : g;
    const seen = groups.get(e.toNodeId);
    if (seen !== undefined && depth(seen) <= depth(child)) continue;
    groups.set(e.toNodeId, child);
    queue.push(e.toNodeId);
  }
}

const unreached = nodes.filter((n) => !groups.has(n.id)).map((n) => n.id);
if (unreached.length) die(`unreachable from START: ${unreached.join(", ")} - fix the edges, not the groups`);
nodes.forEach((n, i) => { n.groupId = groups.get(n.id); n.index = i + 1; n.debug = false; n.dirty = false; });

for (const n of nodes) {
  if (n.context?.resourceName !== GROOVY.resourceName) continue;
  const p = n.inputs?.parameters ?? {};
  if (!Object.keys(p).length) die(`${n.id} has code but binds no parameters`);
  const declared = new Set(Object.keys(n.inputs.input.properties));
  for (const k of Object.keys(p)) if (!declared.has(k)) die(`${n.id} binds ${k} but does not declare it`);
}

const definition = {
  name: "ICM | Bulk Manage Positions",
  description:
    "Creates positions from a CSV in ONE run: every row is checked against the title catalog and against only the "
    + "positions and people the file names, then new positions, their title rows and their holders are written in "
    + "three bulk calls. An existing position can be renamed, or given a title or holder on a date where it has none; "
    + "a DIFFERENT title or holder is refused and pointed at the Positions drawer, where that change is dated. Ids are "
    + "minted from the position code, so the same file uploaded twice changes nothing the second time. dryRun previews.",
  nodes, edges, settings: {}, standard: false,
};

const dest = path.join(ROOT, "build", "bulk-manage-positions.json");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(definition, null, 1));
console.log(`wrote ${path.relative(ROOT, dest)}`);
console.log(`  nodes ${nodes.length}  edges ${edges.length}`);
for (const n of nodes) if (n.groupId !== ROOT_GROUP) console.log(`  ${n.id.padEnd(10)} ${n.groupId}`);

#!/usr/bin/env node
// Make a script node's DECLARED schemas match what it actually binds and returns.
//
//   node scripts/sync-node-schemas.mjs <workflowId> --payload '<json>'   show the diff
//   node scripts/sync-node-schemas.mjs <workflowId> --payload '<json>' --apply
//   node scripts/sync-node-schemas.mjs <workflowId> --types-only [--apply]
//
// --types-only needs NO run and NO payload. It only retypes a bound array parameter
// from `array` to ["string","array"], which is what makes the builder show its mapping
// instead of an empty MappedArrayField. Because it never executes the draft, it is the
// only mode safe to point at a callable that WRITES.
//
// A Groovy node carries two parameter lists that look interchangeable and are not:
//
//   inputs.parameters  the name -> {{ expression }} map. THIS is what binds
//                      variables into the script.
//   inputs.input       a JSON schema. This is only what the BUILDER renders the
//                      "Parameters" form from. It binds nothing.
//                      inputs.output is the same story for the variable picker.
//
// Cloning a workflow copies both, and rewriting the code updates neither, so the
// builder ends up advertising fields no code reads and hiding fields it does. See
// notes/runtime-facts.md, "A Groovy node has TWO parameter lists".
//
// Types are read off a REAL RUN rather than parsed out of the Groovy, because the
// values themselves are the only authority on what a binding actually carries. A node
// the run never reached is REPORTED AND SKIPPED - a schema invented for an unobserved
// node is the same guess this script exists to remove.
//
// Runs execute the DRAFT, so the payload must be safe to run for real.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const die = (m) => { console.error(`error: ${m}`); process.exit(1); };

const vars = {};
for (const line of fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m && !line.trim().startsWith("#")) vars[m[1]] = m[2];
}
const env = vars.UA_DEFAULT_ENV || "orbit";
const baseUrl = vars[env === "orbit" ? "UA_ORBIT_URL" : "UA_TOOL_URL"];
const cookie = vars[env === "orbit" ? "UA_ORBIT_COOKIE" : "UA_TOOL_COOKIE"];
if (!baseUrl || !cookie) die(`missing url or cookie for env "${env}"`);
const headers = { cookie: `_at=${cookie}`, "content-type": "application/json" };

const api = async (p, body) => {
  const r = await fetch(baseUrl + p, {
    method: body === undefined ? "GET" : "POST", headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : {};
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const workflowId = args[0];
const apply = args.includes("--apply");
const typesOnly = args.includes("--types-only");
const pi = args.indexOf("--payload");
if (!workflowId || (pi === -1 && !typesOnly)) {
  die("usage: sync-node-schemas.mjs <workflowId> (--payload '<json>' | --types-only) [--apply]");
}
let payload;
if (!typesOnly) {
  try { payload = JSON.parse(args[pi + 1]); } catch { die("--payload must be valid JSON"); }
}

// ---------------------------------------------------------------------------
// Type inference from an observed value
// ---------------------------------------------------------------------------

// An absent value gets NO type rather than a guessed one. An empty schema accepts
// anything, which is honest; "string" would be a claim the run did not support.
//
// `binds` says whether this type describes a PARAMETER (something a {{ }} expression is
// mapped into) or a returned field. It only changes anything for arrays - see below.
function jtype(v, binds = false) {
  if (v === null || v === undefined) return {};
  if (Array.isArray(v)) {
    const el = v.find((x) => x !== null && x !== undefined);
    const t = typeof el;
    const items =
      t === "string" ? { type: "string" }
      : t === "number" ? { type: Number.isInteger(el) ? "integer" : "number" }
      : t === "boolean" ? { type: "boolean" }
      : { type: "object", properties: {} };
    // A bare `{{ node.outputs.objects }}` is NOT a valid value for a `type: "array"`
    // parameter. That declaration renders as MappedArrayField - a "<Title> List Source"
    // plus "Items" pair whose only accepted values are a literal array or a
    // {source, items, "ua:type":"mappedArray"} envelope - so a whole-value template
    // matches neither, the widget draws itself empty, and a mapping that works
    // perfectly at runtime looks unset.
    //
    // ["string", "array"] is the platform's own idiom for binding a whole list (see
    // the `listSource` parameter on utility_by_unifyapps_filter_list). The field picker
    // reads type[0], so it renders a plain expression input that shows the mapping, and
    // the input validator accepts a bare pill as soon as "string" is among the accepted
    // types. The BINDING is untouched - this is the declaration catching up to the
    // value, not the value being changed to suit the form.
    return binds ? { type: ["string", "array"], items } : { type: "array", items };
  }
  switch (typeof v) {
    case "boolean": return { type: "boolean" };
    case "number": return Number.isInteger(v) ? { type: "integer" } : { type: "number" };
    case "string": return { type: "string" };
    default: return { type: "object", additionalProperties: true, properties: {} };
  }
}

// "planId" -> "Plan Id", matching how the platform titles the trigger's own fields.
const humanize = (k) =>
  k.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

const schema = (entries) => ({
  type: "object",
  additionalProperties: false,
  required: [],
  properties: Object.fromEntries(entries),
});

const getPath = (obj, p) => p.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);

// Delegated to ua-write rather than posting here: that script fills in the edge
// metadata the builder canvas needs (without it every node past a branch stops
// rendering) and enforces the production-write opt-in. One writer, one set of
// safeguards.
//
// Then READ IT BACK. A parameter went missing across one of these writes once, and
// nothing noticed until a later run reported a node that had quietly stopped being
// reported at all. Asserting the bindings survived is cheap; discovering it from a
// broken automation is not.
function writeDraft(definition, note) {
  const bindingsBefore = Object.fromEntries(
    definition.nodes.filter((n) => n.inputs?.parameters).map((n) => [n.id, Object.keys(n.inputs.parameters).sort().join(",")]),
  );
  const out = path.join(ROOT, `.tmp-schema-sync-${workflowId}.json`);
  fs.writeFileSync(out, JSON.stringify(definition, null, 1));
  const { status } = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "ua-write.mjs"), "update", workflowId, out],
    { stdio: "inherit" },
  );
  fs.unlinkSync(out);
  if (status !== 0) die("ua-write refused the update - the draft is unchanged");

  return api(`/api/workflow-definition/${workflowId}`).then((after) => {
    const lost = [];
    for (const n of after.nodes ?? []) {
      const want = bindingsBefore[n.id];
      if (want === undefined) continue;
      const got = Object.keys(n.inputs?.parameters ?? {}).sort().join(",");
      if (got !== want) lost.push(`   ${n.id}: sent [${want}] but the draft now holds [${got || "nothing"}]`);
    }
    if (lost.length) {
      console.error("\nWRITE LANDED BUT BINDINGS DID NOT SURVIVE:");
      for (const l of lost) console.error(l);
      die("restore these before running the automation");
    }
    console.log(`\n${note}; bindings read back intact.`);
  });
}

// ---------------------------------------------------------------------------
// Run the draft and collect every node's observed output
// ---------------------------------------------------------------------------

async function readNode(runId, nodeId) {
  const key = `${runId}.${runId}.${nodeId}`;
  const d = await api("/api/lookup", {
    type: "ByKeys", lookupType: "TEST_WORKFLOW_VARIABLE", keys: [key],
    options: { startTime: Date.now() - 3600000, endTime: Date.now() + 60000, workflowId },
  });
  return d.response?.objects?.[key] ?? [];
}

const wf = await api(`/api/workflow-definition/${workflowId}`);
if (!wf.nodes) die(`no draft nodes for workflow ${workflowId}`);
console.log(`${wf.name} (${workflowId}, draft v${wf.version})\n`);

if (typesOnly) {
  let retyped = 0;
  const unboundT = [];
  for (const n of wf.nodes) {
    if (n.inputs?.code === undefined) continue;
    const params = n.inputs.parameters;
    if (!params || Object.keys(params).length === 0) { unboundT.push(`${n.id} (${n.subTitle})`); continue; }
    for (const [k, sch] of Object.entries(n.inputs.input?.properties ?? {})) {
      if (sch.type === "array" && k in params) {
        sch.type = ["string", "array"];
        console.log(`${n.id}  ${k}: "array" -> ["string","array"]  (mapping was hidden)`);
        retyped++;
      }
    }
  }
  if (unboundT.length) {
    console.error("\nREFUSING TO WRITE - script node(s) with code but no bound parameters:");
    for (const u of unboundT) console.error("   " + u);
    process.exit(1);
  }
  if (retyped === 0) { console.log("no bound array parameter is hiding its mapping"); process.exit(0); }
  if (!apply) { console.log(`\n${retyped} parameter(s) would change. Re-run with --apply.`); process.exit(0); }
  // awaited, not fired and forgotten - the read-back assertion is the point
  await writeDraft(wf, `retyped ${retyped} parameter(s)`);
  process.exit(0);
}

const init = await api(`/api/test-workflow/initiate-test/${workflowId}`, {
  type: "MOCK", workflowDefinition: wf, payload,
});
const runId = init.runId;
if (!runId) die("initiate-test returned no runId");
console.log(`run ${runId} - waiting for nodes to report\n`);

const stopIds = wf.nodes.filter((n) => n.type === "STOP").map((n) => n.id);
const observed = {};
for (let i = 0; i < 24; i++) {
  await sleep(5000);
  for (const n of wf.nodes) {
    if (observed[n.id]) continue;
    const out = (await readNode(runId, n.id)).find((e) => e.type === "outputs")?.payload;
    if (out) observed[n.id] = out;
  }
  if (stopIds.some((id) => observed[id])) break;
}
if (Object.keys(observed).length === 0) die(`run ${runId} produced no node output`);

// ---------------------------------------------------------------------------
// Rebuild each script node's schemas from what the run actually carried
// ---------------------------------------------------------------------------

let changed = 0;
const skipped = [];
const unbound = [];

for (const n of wf.nodes) {
  if (n.inputs?.code === undefined) continue;
  const params = n.inputs.parameters;

  // A script node with code but NO parameters is broken, not merely undeclared: the
  // code reads variables nothing binds, so it throws on the first line that touches
  // one. Skipping it quietly is how it stays broken - this ran once and the only
  // symptom was a node absent from the report.
  if (!params || Object.keys(params).length === 0) {
    unbound.push(`${n.id} (${n.subTitle})`);
    continue;
  }

  if (!observed[n.id]) { skipped.push(`${n.id} (${n.subTitle}) - the run never reached it`); continue; }

  const before = { input: n.inputs.input, output: n.inputs.output };

  // INPUT: exactly the bound keys, typed by the value the binding resolved to.
  const inputEntries = [];
  for (const [key, expr] of Object.entries(params)) {
    let value;
    const m = /^\s*\{\{\s*([A-Za-z0-9_]+)\.outputs\.(.+?)\s*\}\}\s*$/.exec(String(expr));
    if (m && observed[m[1]]) value = getPath(observed[m[1]], m[2]);
    inputEntries.push([key, { ...jtype(value, true), title: humanize(key) }]);
  }

  // OUTPUT: the keys the script actually returned. A Groovy node's return map lands
  // under `result`, which is how every binding in this repo addresses it.
  const result = observed[n.id]?.result;
  const outputEntries =
    result && typeof result === "object" && !Array.isArray(result)
      ? Object.entries(result).map(([k, v]) => [k, jtype(v)])
      : null;

  n.inputs.input = schema(inputEntries);
  if (outputEntries) n.inputs.output = schema(outputEntries);

  const dInput = JSON.stringify(before.input) !== JSON.stringify(n.inputs.input);
  const dOutput = JSON.stringify(before.output) !== JSON.stringify(n.inputs.output);
  if (!dInput && !dOutput) continue;
  changed++;

  console.log(`${n.id}  (${n.subTitle})`);
  const names = (s) => Object.keys(s?.properties ?? {});
  if (dInput) {
    const was = names(before.input), now = names(n.inputs.input);
    console.log(`   input   was: ${was.join(", ") || "(none)"}`);
    console.log(`           now: ${now.join(", ") || "(none)"}`);
    const ghost = was.filter((k) => !now.includes(k));
    const hidden = now.filter((k) => !was.includes(k));
    if (ghost.length) console.log(`           removed ghosts nothing binds: ${ghost.join(", ")}`);
    if (hidden.length) console.log(`           surfaced real bindings it hid: ${hidden.join(", ")}`);
  }
  if (dOutput) {
    console.log(`   output  was: ${names(before.output).join(", ") || "(none)"}`);
    console.log(`           now: ${names(n.inputs.output).join(", ") || "(none)"}`);
  }
  console.log();
}

if (unbound.length) {
  console.error("REFUSING TO WRITE - these script nodes have code but no bound parameters:");
  for (const u of unbound) console.error("   " + u);
  console.error("\nTheir code reads variables nothing supplies, so they throw at runtime.");
  console.error("Restore the bindings first; this script only fixes DECLARATIONS.");
  process.exit(1);
}

if (skipped.length) {
  console.log("SKIPPED - no observed run data, schema left alone rather than guessed:");
  for (const s of skipped) console.log("   " + s);
  console.log();
}

if (changed === 0) { console.log("every script node already declares what it binds"); process.exit(0); }

if (!apply) {
  console.log(`${changed} node(s) would change. Re-run with --apply to write the draft.`);
  process.exit(0);
}

await writeDraft(wf, `applied to ${changed} node(s)`);

#!/usr/bin/env node
// Kit-side automation linter - the rules the platform validator does NOT
// enforce, each derived from the source of truth:
//   runtime:  ~/uacode  (workflow/rt, infra/filter)
//   builder:  ~/frontend/www3 (packages/llm-tools .../automation-inputSchemaValidation)
// Born from the 2026-08-23 post-mortem: suites green + validate clean while
// the builder showed dangling paths and unmapped fields. When this linter
// meets a construct it does not know, the answer comes from reading uacode/
// www3 - and becomes a new rule here. Never weaken a rule to make a graph
// pass.
//
//   node scripts/lint.mjs <id> [<id>...]        lint current platform defs
//   node scripts/lint.mjs --file <path.json>    lint a local definition
//
// Exit 1 when any finding is reported.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_ID } from "./kit-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function die(msg) { console.error(`error: ${msg}`); process.exit(1); }

// ---- auth (same pattern as ua.mjs) ----
const vars = {};
for (const line of fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m && !line.trim().startsWith("#")) vars[m[1]] = m[2];
}
const envName = vars.UA_DEFAULT_ENV || "orbit";
const baseUrl = vars[envName === "orbit" ? "UA_ORBIT_URL" : "UA_TOOL_URL"];
const cookie = vars[envName === "orbit" ? "UA_ORBIT_COOKIE" : "UA_TOOL_COOKIE"];

async function fetchDef(id) {
  const res = await fetch(`${baseUrl}/api/workflow-definition/${id}`, {
    headers: { cookie: `_at=${cookie}` },
  });
  if (!res.ok) die(`fetch ${id}: HTTP ${res.status}`);
  return res.json();
}

// Valid filter operators - uacode infra/filter/api/_UIFilter.java, enum SimpleOps.
const SIMPLE_OPS = new Set([
  "EQUAL","NOT_EQUAL","CONTAINS","IN","NOT_IN","NOT_CONTAINS","ICONTAINS",
  "NOT_ICONTAINS","REGEX","NOT_REGEX","IREGEX","NOT_IREGEX","STARTS_WITH",
  "NOT_STARTS_WITH","ENDS_WITH","NOT_ENDS_WITH","MIN_LENGTH","MAX_LENGTH",
  "EXISTS","MISSING","LT","LTE","GT","GTE","BETWEEN","WITHIN",
]);

// resourceName allowlist, harvested from every snapshot in the repo (all of
// which have passed validate at some point). An unknown resourceName is not
// necessarily wrong - but it is a finding until someone confirms it against
// uacode and (if real) adds it here or re-snapshots.
// Resources not (yet) in any snapshot but confirmed to exist in the runtime
// source - each entry cites its uacode config file. R7's corpus check unions
// these in; delete an entry only if the config disappears from uacode.
const UACODE_VERIFIED_RESOURCES = new Set([
  "loop_while",                              // uacode configs/workflow-nodes/loop/loop_while.json
  "variable_by_unifyapps_create_variables",  // uacode configs/workflow-nodes/variable_by_unifyapps/variable_by_unifyapps_create_variables.json
  "variable_by_unifyapps_update_variables",  // uacode configs/workflow-nodes/variable_by_unifyapps/variable_by_unifyapps_update_variables.json
]);

function knownResourceNames() {
  const known = new Set(UACODE_VERIFIED_RESOURCES);
  const dir = path.join(ROOT, "snapshots", envName, "automations");
  if (!fs.existsSync(dir)) return known;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const n of d.nodes ?? []) {
      const rn = n.context?.resourceName;
      if (rn) known.add(rn);
    }
  }
  return known;
}

// appName the corpus pairs with each resourceName. The builder resolves a
// node's panel by appName+resourceName; a wrong appName RUNS fine but renders
// as "no actions found" with an empty parameters panel (if_else_condition
// needs appName "if_else" - bit the Create Issue build 2026-08-24).
function knownAppNames() {
  const pairs = new Map(); // resourceName -> Set(appName)
  const dir = path.join(ROOT, "snapshots", envName, "automations");
  if (!fs.existsSync(dir)) return pairs;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const n of d.nodes ?? []) {
      const rn = n.context?.resourceName, an = n.context?.appName;
      if (rn && an) (pairs.get(rn) ?? pairs.set(rn, new Set()).get(rn)).add(an);
    }
  }
  return pairs;
}

function lint(def, knownRes, knownApps) {
  const findings = [];
  const F = (node, rule, msg) => findings.push({ node, rule, msg });
  const nodes = new Map((def.nodes ?? []).map((n) => [n.id, n]));
  const edges = def.edges ?? [];
  const out = new Map(); // nodeId -> edges out
  const inn = new Map(); // nodeId -> edges in
  for (const e of edges) {
    (out.get(e.fromNodeId) ?? out.set(e.fromNodeId, []).get(e.fromNodeId)).push(e);
    (inn.get(e.toNodeId) ?? inn.set(e.toNodeId, []).get(e.toNodeId)).push(e);
  }

  // ---------- R1: edge vocabulary (builder renders from names, not runtime tolerance) ----------
  for (const e of edges) {
    const from = nodes.get(e.fromNodeId);
    if (!from) { F(e.fromNodeId, "R1", `edge from unknown node`); continue; }
    if (!nodes.has(e.toNodeId)) F(e.fromNodeId, "R1", `edge to unknown node ${e.toNodeId}`);
    if (from.type === "IF_ELSE") {
      const want = e.type === "if" ? "yes" : "no";
      if (e.name !== want) F(from.id, "R1", `IF edge to ${e.toNodeId} needs name "${want}" (has ${JSON.stringify(e.name)})`);
    }
    if (from.type === "BRANCH") {
      if (e.type !== "branch") { F(from.id, "R1", `edge out of BRANCH must be type branch (got ${e.type})`); continue; }
      const ids = new Set((from.inputs?.branches ?? []).map((b) => b.id));
      if (!e.name || !ids.has(e.name)) F(from.id, "R1", `branch edge to ${e.toNodeId} needs a name matching a branches[] id (has ${JSON.stringify(e.name)}, ids ${[...ids].join(",")})`);
    }
  }

  // ---------- R2: IF_ELSE input shape (uacode ResolvedUIFilter parses inputs directly) ----------
  const checkFilterList = (nid, rule, obj, where) => {
    if (!obj || typeof obj !== "object") { F(nid, rule, `${where}: missing conditions`); return; }
    if (obj.conditions) { F(nid, rule, `${where}: wrapped in a 'conditions' key - runtime sees no filters, condition is silently false`); return; }
    if (!Array.isArray(obj.filters)) { F(nid, rule, `${where}: no filters array`); return; }
    for (const f of obj.filters) {
      if (!f.filter || typeof f.filter !== "object") { F(nid, rule, `${where}: flat filter entry {property,operator,value} - must nest {property, filter:{operator,value}}`); continue; }
      if (!SIMPLE_OPS.has(f.filter.operator)) F(nid, rule, `${where}: unknown operator ${JSON.stringify(f.filter.operator)} (SimpleOps enum, uacode infra/filter)`);
    }
  };
  for (const n of nodes.values()) {
    if (n.type === "IF_ELSE") checkFilterList(n.id, "R2", n.inputs, "IF_ELSE inputs");
    if (n.type === "BRANCH_CONDITION") checkFilterList(n.id, "R2", n.inputs?.conditions, "branch condition");
  }

  // ---------- R3/R4: BRANCH structure (uacode BranchNodeRuntime) ----------
  for (const n of nodes.values()) {
    if (n.type !== "BRANCH") continue;
    const branches = n.inputs?.branches ?? [];
    if (!branches.some((b) => b.id === "default")) F(n.id, "R3", `branches[] has no "default" entry`);
    for (const b of branches) {
      if (b.id === "default") continue;
      const fl = b.inputs?.conditions?.filters;
      if (!Array.isArray(fl) || !fl.length) F(n.id, "R3", `branch "${b.id}" has empty filters - the arm never spawns`);
    }
    const branchEdges = (out.get(n.id) ?? []).filter((e) => e.type === "branch");
    const joinEdge = branchEdges.find((e) => e.name === "default");
    if (!joinEdge) { F(n.id, "R3", `no default (join) branch edge`); continue; }
    const join = nodes.get(joinEdge.toNodeId);
    if (join && join.groupId !== n.groupId)
      F(n.id, "R4", `join target ${join.id} must sit in the branch's own group "${n.groupId}" (has "${join.groupId}") - in @default it becomes a parallel arm and the run stalls`);
    // every arm's leaf must point at the join (builder draws convergence from these edges)
    for (const e of branchEdges) {
      if (e.name === "default") continue;
      // walk the arm: nodes whose group starts with `${n.id}@${n.groupId}@${e.name}`
      const armPrefix = `${n.id}@${n.groupId}@${e.name}`;
      const armNodes = [...nodes.values()].filter((x) => (x.groupId ?? "").endsWith(armPrefix) || (x.groupId ?? "").includes(`${armPrefix}@`) || (x.groupId ?? "") === armPrefix);
      for (const a of armNodes) {
        const outs = out.get(a.id) ?? [];
        if (!outs.length && a.type !== "STOP") {
          F(a.id, "R4", `arm leaf has no outgoing edge - add next edge to the join node ${join?.id} (builder shows the arm dangling without it)`);
        }
      }
    }
  }

  // ---------- R5: pill references resolve to real upstream nodes ----------
  const ancestors = (start) => {
    const seen = new Set(); const q = [start];
    while (q.length) {
      const cur = q.pop();
      for (const e of inn.get(cur) ?? []) {
        if (!seen.has(e.fromNodeId)) { seen.add(e.fromNodeId); q.push(e.fromNodeId); }
        // branch arms: the join's inputs may reference arm nodes; arms share the branch ancestor
        const fromNode = nodes.get(e.fromNodeId);
        if (fromNode?.type === "BRANCH") {
          for (const be of out.get(fromNode.id) ?? []) {
            if (!seen.has(be.toNodeId)) { seen.add(be.toNodeId); q.push(be.toNodeId); }
          }
        }
      }
    }
    return seen;
  };
  // Node ids are NOT always n_* - builder-made ones can be _mfOky-style.
  // Match any {{ token. }} pill and treat non-node tokens (__USER__ etc.) as globals.
  const GLOBALS = new Set(["__USER__", "__WORKFLOW__", "__ENV__"]);
  for (const n of nodes.values()) {
    const pills = JSON.stringify(n.inputs ?? {}).match(/\{\{\s*([A-Za-z_][A-Za-z0-9@_]*)\s*\./g) ?? [];
    if (!pills.length) continue;
    const up = ancestors(n.id);
    for (const p of new Set(pills.map((s) => s.replace(/\{\{\s*/, "").replace(/\s*\.$/, "")))) {
      if (GLOBALS.has(p)) continue;
      if (!nodes.has(p)) { F(n.id, "R5", `pill references node ${p} which does not exist`); continue; }
      if (p !== n.id && !up.has(p)) F(n.id, "R5", `pill references ${p} which is not upstream of this node - it may not have run yet`);
    }
  }

  // ---------- R6: array result fields need mappedArray, not a bare pill ----------
  // (www3 llm-tools automation-inputSchemaValidation: invalid array pill representation)
  const trigger = [...nodes.values()].find((x) => x.type === "START");
  const resultSchema = trigger?.inputs?.result?.properties ?? {};
  for (const n of nodes.values()) {
    if (n.type !== "STOP") continue;
    const result = n.inputs?.result ?? {};
    for (const [k, v] of Object.entries(result)) {
      if (resultSchema[k]?.type === "array" && typeof v === "string" && v.includes("{{"))
        F(n.id, "R6", `result field "${k}" is an array but mapped as a bare pill string - the builder shows it unmapped; use {ua:type:"mappedArray", source, items} or a literal array`);
    }
  }

  // ---------- R7: resourceName sanity against the corpus ----------
  for (const n of nodes.values()) {
    const rn = n.context?.resourceName;
    if (rn && knownRes.size && !knownRes.has(rn))
      F(n.id, "R7", `resourceName "${rn}" never seen in any snapshot - confirm against uacode ("No config found for resource" at run time if wrong)`);
    const an = n.context?.appName;
    const wantApps = knownApps.get(rn);
    if (rn && an && wantApps && !wantApps.has(an))
      F(n.id, "R13", `context appName "${an}" never pairs with resourceName "${rn}" in the corpus (expected ${[...wantApps].join("/")}) - the builder renders "no actions found" on a wrong appName even though the runtime executes it`);
  }

  // ---------- R14: node TYPE must match its resource class ----------
  // Proven on the Create Saved View build (2026-08-24): a
  // callables_call_automation node with type ACTION passes validate AND
  // this linter but dies at run time with "No config found for resource
  // callables_call_automation in app callables". Same class as the
  // respond-node TYPE=STOP rule: the runtime resolves the resource by
  // node TYPE first.
  for (const n of nodes.values()) {
    const rn = n.context?.resourceName;
    if (rn === "callables_call_automation" && n.type !== "CALL_WORKFLOW")
      F(n.id, "R14", `CallWorkflow node has type ${n.type}, must be CALL_WORKFLOW - runs fail with "No config found for resource callables_call_automation" (validate does not catch this)`);
    if (rn === "callables_return_to_automation" && n.type !== "STOP")
      F(n.id, "R14", `respond node has type ${n.type}, must be STOP (known agent-upgrade trap, see CLAUDE.md testrun quirk)`);
  }

  // ---------- R8: every leaf is a STOP respond node ----------
  for (const n of nodes.values()) {
    const outs = out.get(n.id) ?? [];
    if (!outs.length) {
      if (n.type !== "STOP") F(n.id, "R8", `leaf node is ${n.type}, not STOP - a path ends without responding`);
      else if (n.context?.resourceName && n.context.resourceName !== "callables_return_to_automation")
        F(n.id, "R8", `STOP leaf is ${n.context.resourceName}, expected callables_return_to_automation for a callable`);
    }
    if (n.type === "STOP" && outs.length) F(n.id, "R8", `STOP node has outgoing edges`);
  }

  // ---------- R9: CallWorkflow omitted-optional audit (2026-08-23 incident) ----------
  // A callee's optional input with a default is a silent decision by the
  // caller. Proven case (ua-automationkit, 2026-08-23): Create Team omitted
  // applicationId; the sub fell back to the wrong app and every team it made
  // landed there. applicationId is optional in the callable but MANDATORY to
  // send, and it must equal APP_ID from kit.config.json.
  for (const n of nodes.values()) {
    if (n.type !== "CALL_WORKFLOW") continue;
    const calleeId = n.inputs?.automationId;
    if (!calleeId || String(calleeId).includes("{{")) continue;
    const snapPath = path.join(ROOT, "snapshots", envName, "automations", `${calleeId}.json`);
    if (!fs.existsSync(snapPath)) { F(n.id, "R9", `callee ${calleeId} has no snapshot - snap it so its contract is auditable`); continue; }
    const callee = JSON.parse(fs.readFileSync(snapPath, "utf8"));
    const setup = (callee.nodes ?? []).find((x) => x.type === "START")?.inputs?.setup?.properties ?? {};
    const params = n.inputs?.parameters ?? {};
    if ("applicationId" in setup) {
      const v = params.applicationId;
      if (v === undefined || v === "") {
        F(n.id, "R9", `callee "${callee.name}" accepts applicationId but this call does not send it - the callee's fallback decides the app silently (send ${APP_ID} explicitly)`);
      } else if (typeof v === "string" && !v.includes("{{") && v !== APP_ID) {
        F(n.id, "R9", `callee "${callee.name}" is called with applicationId ${JSON.stringify(v)}, but this product's app id is ${JSON.stringify(APP_ID)} (kit.config.json) - a wrong app id does not error, it silently matches nothing`);
      }
    }
  }

  // ---------- R10: Groovy parameters must be declared in the input schema ----------
  // The builder treats inputs.input as the source of truth: opening + saving
  // the automation in the UI STRIPS any parameters entry not declared there
  // (proven 2026-08-24: Fetch Issues v25 lost its colRows mappedArray, every
  // group count silently 0). Schema == parameters, always.
  for (const n of nodes.values()) {
    if (n.context?.resourceName && !/groovy|code/i.test(n.context.resourceName)) continue;
    const params = n.inputs?.parameters;
    if (!params || typeof params !== "object") continue;
    const declared = n.inputs?.input?.properties ?? {};
    for (const k of Object.keys(params)) {
      if (!(k in declared))
        F(n.id, "R10", `parameter "${k}" is not declared in inputs.input.properties - the builder will strip it on the next UI save`);
    }
  }

  return findings;
}

// ---- main ----
const args = process.argv.slice(2);
if (!args.length) die("usage: lint <id> [<id>...] | lint --file <path.json>");
const knownRes = knownResourceNames();
const knownApps = knownAppNames();
let bad = 0;
for (let i = 0; i < args.length; i++) {
  let def, label;
  if (args[i] === "--file") { def = JSON.parse(fs.readFileSync(args[++i], "utf8")); label = args[i]; }
  else { def = await fetchDef(args[i]); label = `${args[i]}  ${def.name ?? ""}`; }
  const findings = lint(def, knownRes, knownApps);
  if (!findings.length) { console.log(`  clean    ${label}`); continue; }
  bad++;
  console.log(`  FINDINGS ${label}`);
  for (const f of findings) console.log(`             [${f.rule}] ${f.node}: ${f.msg}`);
}
if (bad) { console.log(`${bad} automation(s) with lint findings - not done until clean or each finding is refuted from uacode/www3`); process.exit(1); }

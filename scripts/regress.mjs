#!/usr/bin/env node
// Regression suites for automations. Each automation has one file:
//   tests/<workflowId>.json  ->  {"name": "...", "cases":[{name, payload, checks}]}
// A check is {"path":"teams", "type":"array"} or {"path":"totalCount","min":0}
// Supported check keys (combine freely): type (number|string|boolean|array|object),
// equals, min, max, maxLen, minLen, exists (default true), absent.
//
// Chaining (for suites that write data and clean up after themselves):
//   - a case may set "workflowId" to run a DIFFERENT automation (e.g. the
//     matching Delete callable for cleanup, or a Create callable as fixture);
//   - any payload string of the exact form "{{case:<case name>:<path>}}" is
//     replaced by that earlier case's output value at <path> (e.g.
//     "{{case:fixture: create temp:id}}"). A case whose reference cannot be
//     resolved fails instead of running with a broken payload;
//   - a case may be {"name", "entityCreate": {"entityType", "properties":
//     {...}}}: raw fixture create; the created record (incl. id) becomes the
//     case's output for {{case:<name>:id}} chaining;
//   - a case may be {"name", "entityFind": {"entityType", "filters": {prop:
//     value}}}: looks a seeded fixture up by its BUSINESS key and records it as
//     the case's output, so payloads can chain {{case:<name>:id}} without ever
//     hardcoding a platform id (ids differ per environment and per reseed).
//     Zero matches and >1 match both fail;
//   - a case may be {"name", "entityDelete": {"entityType", "filters": {prop:
//     value}}} instead of a workflow run: it searches records matching ALL
//     filters (values resolve {{case:..}} refs) and hard-deletes each match
//     via /api/entity/create-update-or-delete/hierarchical. For suites whose
//     happy path writes records no delete callable exists for. It fails when
//     zero records match (a cleanup that cleans nothing is a broken suite).
//
//   node scripts/regress.mjs <workflowId>     run one automation's suite
//   node scripts/regress.mjs --all            run every suite in tests/
//
// Runs execute the automation's DRAFT with real nodes (same engine as
// testrun.mjs), so treat suites for automations that WRITE data carefully.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEnv } from "./env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TESTS = path.join(ROOT, "tests");

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const { env, baseUrl, cookie, args: argv } = resolveEnv();
if (!baseUrl || !cookie) die(`missing url or cookie for env "${env}"`);
const headers = { cookie: `_at=${cookie}`, "content-type": "application/json" };

const api = async (p, body) => {
  const r = await fetch(baseUrl + p, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}: ${t.slice(0, 200)}`);
  return JSON.parse(t);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readNode(workflowId, runId, nodeId) {
  const key = `${runId}.${runId}.${nodeId}`;
  const d = await api("/api/lookup", {
    type: "ByKeys",
    lookupType: "TEST_WORKFLOW_VARIABLE",
    keys: [key],
    options: { startTime: Date.now() - 3600000, endTime: Date.now() + 60000, workflowId },
  });
  return d.response?.objects?.[key] ?? [];
}

async function runOnce(wf, payload) {
  // orbit's initiate-test intermittently answers HTTP 500 "No Response
  // received within specified timeout" under load (seen 3 runs in a row,
  // 2026-08-24). One retry after a beat absorbs the flake; a second failure
  // is reported as before. NOTE for creating automations: a timed-out
  // initiate MAY still have executed, so a flaked-then-retried create can
  // consume an extra identifier - suites pinning identifier sequences can
  // still shift on the flake itself, retry or not.
  let initResp;
  for (let attempt = 0; ; attempt++) {
    try {
      initResp = await api(`/api/test-workflow/initiate-test/${wf.id}`, {
        type: "MOCK",
        workflowDefinition: wf,
        payload,
      });
      break;
    } catch (e) {
      if (attempt === 0 && /within specified timeout|DEADLINE_EXCEEDED/i.test(String(e))) {
        await sleep(8000);
        continue;
      }
      throw e;
    }
  }
  const { runId } = initResp;
  const nodeIds = wf.nodes.map((n) => n.id);
  // an automation can end at ANY of its respond (STOP) nodes, not just the
  // graph's last node - poll all of them and take whichever produced output
  const stopIds = wf.nodes.filter((n) => n.type === "STOP").map((n) => n.id);
  if (stopIds.length === 0) stopIds.push(nodeIds[nodeIds.length - 1]);
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    for (const id of stopIds) {
      const out = (await readNode(wf.id, runId, id)).find((e) => e.type === "outputs")?.payload;
      if (out) return { runId, output: out, failedNode: out.errorMessage ? id : null };
    }
    for (const id of nodeIds) {
      const out2 = (await readNode(wf.id, runId, id)).find((e) => e.type === "outputs")?.payload;
      if (out2?.errorMessage || out2?.rootCauseMessage) return { runId, output: out2, failedNode: id };
    }
  }
  return { runId, output: null, failedNode: "(timed out)" };
}

const getPath = (obj, p) => p.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);

function checkOne(output, c) {
  const v = getPath(output, c.path);
  const fails = [];
  // `absent: true` asserts the key is genuinely NOT there. `exists: false` only
  // tolerates a missing key; it can never fail on a value that showed up, which
  // is the wrong tool for pinning "no lead means no lead object at all".
  if (c.absent === true && v !== undefined) fails.push(`present (${JSON.stringify(v)}), wanted absent`);
  if (c.exists !== false && c.absent !== true && v === undefined) fails.push("missing");
  if (v !== undefined) {
    if (c.type === "array" ? !Array.isArray(v) : c.type && typeof v !== c.type) fails.push(`type is ${Array.isArray(v) ? "array" : typeof v}, wanted ${c.type}`);
    if ("equals" in c && JSON.stringify(v) !== JSON.stringify(c.equals)) fails.push(`= ${JSON.stringify(v)}, wanted ${JSON.stringify(c.equals)}`);
    if ("min" in c && !(v >= c.min)) fails.push(`${v} < min ${c.min}`);
    if ("max" in c && !(v <= c.max)) fails.push(`${v} > max ${c.max}`);
    if ("minLen" in c && !(v?.length >= c.minLen)) fails.push(`len ${v?.length} < ${c.minLen}`);
    if ("maxLen" in c && !(v?.length <= c.maxLen)) fails.push(`len ${v?.length} > ${c.maxLen}`);
  }
  return fails;
}

async function runSuite(workflowId) {
  const file = path.join(TESTS, `${workflowId}.json`);
  if (!fs.existsSync(file)) die(`no suite at ${path.relative(ROOT, file)}`);
  const suite = JSON.parse(fs.readFileSync(file, "utf8"));
  const wf = await api(`/api/workflow-definition/${workflowId}`);
  console.log(`\n${wf.name} (${workflowId}, draft v${wf.version}) - ${suite.cases.length} case(s)`);
  const wfCache = { [workflowId]: wf };
  const getWf = async (id) => (wfCache[id] ??= await api(`/api/workflow-definition/${id}`));
  const outputs = {};
  const resolve = (v) => {
    if (typeof v === "string") {
      const m = v.match(/^\{\{case:(.+):([^:]+)\}\}$/);
      if (m) {
        if (!(m[1] in outputs)) throw new Error(`references case "${m[1]}" which has no recorded output`);
        return getPath(outputs[m[1]], m[2]);
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
    return v;
  };
  let failed = 0;
  for (const cs of suite.cases) {
    if (cs.entityCreate) {
      // {"name", "entityCreate": {"entityType", "properties": {...}}} - raw
      // fixture create via the hierarchical endpoint (values resolve
      // {{case:..}} refs). The created record (with its id) becomes the
      // case's recorded output, so later cases can chain {{case:<name>:id}}.
      // An optional "ownerUserId" is forwarded on the ENTITY (not in
      // properties), which is the only way to seed a record owned by
      // somebody else - required to test author-only permission paths,
      // since everything the kit creates is otherwise owned by the caller.
      try {
        const { entityType, properties, ownerUserId } = cs.entityCreate;
        const entity = { entityType, properties: resolve(properties) };
        if (ownerUserId !== undefined) entity.ownerUserId = ownerUserId;
        const made = await api("/api/entity/create-update-or-delete/hierarchical", { entity, requestType: "CREATED" });
        const obj = Array.isArray(made) ? made[0] : made;
        if (!obj?.id) throw new Error("create returned no id");
        outputs[cs.name] = obj;
        console.log(`  pass ${cs.name} (created ${entityType} ${obj.id})`);
      } catch (e) {
        failed++;
        console.log(`  FAIL ${cs.name}: ${e.message}`);
      }
      continue;
    }
    if (cs.entityDelete) {
      try {
        const { entityType, filters, allowZero } = cs.entityDelete;
        // /api/entity uses the PLATFORM Query shape (op/field/values), NOT the storage shape
        const query = { op: "AND", values: Object.entries(filters).map(([k, v]) => ({ field: `properties.${k}`, op: "EQUAL", values: [resolve(v)] })) };
        const found = await api(`/api/entity/${entityType}`, { filter: query, page: { limit: 50, offset: 0 } });
        const hits = found.response?.objects ?? found.objects ?? [];
        // allowZero: for PRE-cleanup steps that tidy leftovers from an earlier
        // run that died mid-way. Nothing to delete is the healthy case there,
        // while a post-cleanup matching zero still means the fixture escaped.
        if (!hits.length && allowZero) { console.log(`  pass ${cs.name} (nothing to clean)`); continue; }
        if (!hits.length) throw new Error("cleanup matched zero records");
        for (const h of hits) await api("/api/entity/create-update-or-delete/hierarchical", { entity: { entityType, id: h.id }, requestType: "DELETED" });
        console.log(`  pass ${cs.name} (deleted ${hits.length} ${entityType})`);
      } catch (e) {
        failed++;
        console.log(`  FAIL ${cs.name}: ${e.message}`);
      }
      continue;
    }
    if (cs.entityFind) {
      // {"name", "entityFind": {"entityType", "filters": {prop: value}}} -
      // look a fixture up by its BUSINESS key and record it as the case's
      // output, so later payloads chain {{case:<name>:id}}.
      //
      // The point is that a suite never hardcodes a platform id. Ids are minted
      // per environment and per reseed, so a suite pinned to one is green on
      // the machine that wrote it and red everywhere else. Fixtures are seeded
      // by scripts/fixtures.mjs and found here by the key a human recognises.
      //
      // Zero matches and MORE THAN ONE both fail: a fixture that silently
      // duplicated would otherwise let the suite assert against an arbitrary
      // one of them.
      try {
        const { entityType, filters } = cs.entityFind;
        const query = { op: "AND", values: Object.entries(filters).map(([k, v]) => ({ field: `properties.${k}`, op: "EQUAL", values: [resolve(v)] })) };
        const found = await api(`/api/entity/${entityType}`, { filter: query, page: { limit: 10, offset: 0 } });
        const hits = found.response?.objects ?? found.objects ?? [];
        if (hits.length === 0) throw new Error(`no ${entityType} matching ${JSON.stringify(filters)} - is the fixture family seeded? (node scripts/fixtures.mjs seed <family>)`);
        if (hits.length > 1) throw new Error(`${hits.length} ${entityType} records match ${JSON.stringify(filters)} - a fixture duplicated`);
        outputs[cs.name] = hits[0];
        console.log(`  pass ${cs.name} (found ${entityType} ${hits[0].id})`);
      } catch (e) {
        failed++;
        console.log(`  FAIL ${cs.name}: ${e.message}`);
      }
      continue;
    }
    if (cs.sleepMs) {
      // for suites whose read cases follow their own write fixtures: record
      // search visibly lags the create by tens of seconds (seen on Fetch
      // Projects 2026-08-23) - a case {"name", "sleepMs"} just waits it out
      await sleep(cs.sleepMs);
      console.log(`  pass ${cs.name} (slept ${cs.sleepMs}ms)`);
      continue;
    }
    let caseWf, payload, run;
    try {
      caseWf = cs.workflowId ? await getWf(cs.workflowId) : wf;
      payload = resolve(cs.payload ?? {});
      run = await runOnce(caseWf, payload);
    } catch (e) {
      // a transient platform error must fail the CASE, not kill the process -
      // later cleanup cases still have to run
      failed++;
      console.log(`  FAIL ${cs.name}: ${e.message}`);
      continue;
    }
    const { runId, output, failedNode } = run;
    if (output && !failedNode) outputs[cs.name] = output;
    if (failedNode) {
      failed++;
      console.log(`  FAIL ${cs.name}: node ${failedNode} errored - ${output?.rootCauseMessage ?? output?.errorMessage ?? "no output"}  (run ${runId})`);
      continue;
    }
    // Checks resolve {{case:<name>:<path>}} refs exactly like payloads do, so
    // a case can assert against an EARLIER case's output ("the second create
    // returns the first view's id"). Added 2026-08-25; before it, such a value
    // was compared literally and could only ever fail.
    let problems;
    try {
      problems = (cs.checks ?? []).flatMap((c) => checkOne(output, resolve(c)).map((f) => `${c.path}: ${f}`));
    } catch (e) {
      failed++;
      console.log(`  FAIL ${cs.name}: ${e.message}  (run ${runId})`);
      continue;
    }
    if (problems.length) {
      failed++;
      console.log(`  FAIL ${cs.name}: ${problems.join("; ")}  (run ${runId})`);
    } else {
      console.log(`  pass ${cs.name}`);
    }
  }
  return failed;
}

const arg = argv[0];
if (!arg) die("usage: node scripts/regress.mjs <workflowId> | --all");
let totalFailed = 0;
if (arg === "--all") {
  const files = fs.existsSync(TESTS) ? fs.readdirSync(TESTS).filter((f) => f.endsWith(".json")) : [];
  if (files.length === 0) die("no suites in tests/");
  for (const f of files) totalFailed += await runSuite(f.replace(/\.json$/, ""));
} else {
  totalFailed = await runSuite(arg);
}
console.log(totalFailed === 0 ? "\nall green" : `\n${totalFailed} case(s) FAILED`);
process.exit(totalFailed === 0 ? 0 : 1);

#!/usr/bin/env node
// Debug a workflow run: print every node's real inputs, outputs and errors.
// Works for REAL (deployed) runs and for test runs.
//
//   node scripts/debugrun.mjs <workflowId> <runId>
//   node scripts/debugrun.mjs <workflowId> <runId> --save-case "name for the case"
//
// The run id is in the run URL: /automations/<workflowId>/runs/<runId>.
// --save-case takes the run's trigger payload and appends it to
// tests/<workflowId>.json as a new regression case, so every production
// failure permanently becomes a test.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEnv } from "./env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const { env, baseUrl, cookie, args: argv } = resolveEnv();
if (!baseUrl || !cookie) die(`missing url or cookie for env "${env}"`);
const headers = { cookie: `_at=${cookie}`, "content-type": "application/json" };

const [workflowId, runId, saveFlag, caseName] = argv;
if (!workflowId || !runId) die('usage: node scripts/debugrun.mjs <workflowId> <runId> [--save-case "name"]');

const api = async (p, body) => {
  const r = await fetch(baseUrl + p, { method: "POST", headers, body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) die(`${p} -> HTTP ${r.status}: ${t.slice(0, 200)}`);
  return JSON.parse(t);
};

const wf = await (await fetch(`${baseUrl}/api/workflow-definition/${workflowId}`, { headers })).json();
if (!wf.nodes) die(`could not fetch workflow ${workflowId}`);

async function readNode(lookupType, nodeId) {
  const key = `${runId}.${runId}.${nodeId}`;
  const d = await api("/api/lookup", {
    type: "ByKeys",
    lookupType,
    keys: [key],
    options: { workflowId, startTime: 0, endTime: Date.now() + 60000 },
  });
  return d.response?.objects?.[key] ?? [];
}

// Real runs live under WORKFLOW_VARIABLE, test runs under TEST_WORKFLOW_VARIABLE.
let lookupType = "WORKFLOW_VARIABLE";
let probe = await readNode(lookupType, wf.nodes[0].id);
if (probe.length === 0) {
  lookupType = "TEST_WORKFLOW_VARIABLE";
  probe = await readNode(lookupType, wf.nodes[0].id);
}
if (probe.length === 0) die(`no data for run ${runId} under either lookup - wrong run id, wrong workflow, or the run is older than the log retention`);

console.log(`${wf.name} (${workflowId}) - run ${runId} [${lookupType === "WORKFLOW_VARIABLE" ? "real run" : "test run"}]\n`);

let triggerPayload = null;
let failed = false;
for (const n of wf.nodes) {
  const entries = await readNode(lookupType, n.id);
  const inp = entries.find((e) => e.type === "inputs")?.payload;
  const out = entries.find((e) => e.type === "outputs")?.payload;
  const label = `${n.id} (${n.title ?? n.context?.resourceName ?? n.type})`;
  if (!inp && !out) {
    console.log(`== ${label}: not reached`);
    continue;
  }
  if (n.type === "START") triggerPayload = out ?? inp;
  if (out?.errorMessage || out?.rootCauseMessage) {
    failed = true;
    console.log(`== ${label}: FAILED`);
    console.log(`   error: ${out.rootCauseMessage ?? out.errorMessage}`);
    if (inp) console.log(`   inputs: ${JSON.stringify(inp).slice(0, 1000)}`);
  } else {
    console.log(`== ${label}: ok`);
    if (inp) console.log(`   inputs:  ${JSON.stringify(inp).slice(0, 500)}`);
    if (out) console.log(`   outputs: ${JSON.stringify(out).slice(0, 500)}`);
  }
}
if (!failed) console.log("\nrun completed without node errors");

if (saveFlag === "--save-case") {
  if (!triggerPayload) die("could not recover the trigger payload from this run");
  const file = path.join(ROOT, "tests", `${workflowId}.json`);
  const suite = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : { name: wf.name, cases: [] };
  suite.cases.push({
    name: caseName || `from run ${runId}`,
    payload: triggerPayload,
    checks: [],
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(suite, null, 2) + "\n");
  console.log(`\nsaved trigger payload as a new case in ${path.relative(ROOT, file)} - add checks to it, then run regress.mjs`);
}

#!/usr/bin/env node
// Test-run a DRAFT automation (no deploy needed) and print per-node results.
// This executes the workflow's real nodes against real data - use on test
// automations, or on read-only automations you understand.
//
//   node scripts/testrun.mjs <workflowId> ['{"search":"x"}']
//
// How it works (reverse-engineered from the builder UI's Test button):
//   1. POST /api/test-workflow/initiate-test/{id} {type:MOCK, workflowDefinition, payload}
//      -> {runId}. Despite the name MOCK, the nodes really execute.
//   2. Each node's inputs/outputs (or error) are read with
//      POST /api/lookup lookupType TEST_WORKFLOW_VARIABLE, key "runId.runId.nodeId".

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

const [workflowId, payloadArg] = argv;
if (!workflowId) die('usage: node scripts/testrun.mjs <workflowId> [\'{"input":"json"}\']');
const payload = payloadArg ? JSON.parse(payloadArg) : {};

const headers = { cookie: `_at=${cookie}`, "content-type": "application/json" };
const api = async (p, body) => {
  const r = await fetch(baseUrl + p, { method: "POST", headers, body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) die(`${p} -> HTTP ${r.status}: ${t.slice(0, 300)}`);
  return JSON.parse(t);
};

const wf = await (await fetch(`${baseUrl}/api/workflow-definition/${workflowId}`, { headers })).json();
if (!wf.nodes) die(`could not fetch workflow ${workflowId}`);
console.log(`test-running "${wf.name}" (v${wf.version}, ${wf.nodes.length} nodes) with payload ${JSON.stringify(payload)}`);

const { runId } = await api(`/api/test-workflow/initiate-test/${workflowId}`, {
  type: "MOCK",
  workflowDefinition: wf,
  payload,
});
console.log(`run id: ${runId}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nodeIds = wf.nodes.map((n) => n.id);
const readNode = async (nodeId) => {
  const key = `${runId}.${runId}.${nodeId}`;
  const d = await api("/api/lookup", {
    type: "ByKeys",
    lookupType: "TEST_WORKFLOW_VARIABLE",
    keys: [key],
    options: { startTime: Date.now() - 3600000, endTime: Date.now() + 60000, workflowId },
  });
  return d.response?.objects?.[key] ?? [];
};

// Poll until the last node has data or a node errors, max ~2 min.
let failed = false;
for (let attempt = 0; attempt < 24; attempt++) {
  await sleep(5000);
  const last = await readNode(nodeIds[nodeIds.length - 1]);
  if (last.length > 0) break;
  // check for an error anywhere so we stop early
  let anyError = false;
  for (const id of nodeIds) {
    const entries = await readNode(id);
    const out = entries.find((e) => e.type === "outputs")?.payload;
    if (out && (out.errorMessage || out.rootCauseMessage)) { anyError = true; break; }
  }
  if (anyError) { failed = true; break; }
}

console.log("\nper-node results:");
for (const id of nodeIds) {
  const entries = await readNode(id);
  const out = entries.find((e) => e.type === "outputs")?.payload;
  if (!out) {
    console.log(`  ${id}: (no output recorded - not reached or still running)`);
    continue;
  }
  if (out.errorMessage || out.rootCauseMessage) {
    failed = true;
    console.log(`  ${id}: FAILED - ${out.rootCauseMessage ?? out.errorMessage}`);
  } else {
    const s = JSON.stringify(out);
    console.log(`  ${id}: ok - ${s.length > 300 ? s.slice(0, 300) + "..." : s}`);
  }
}

const lastOut = (await readNode(nodeIds[nodeIds.length - 1])).find((e) => e.type === "outputs")?.payload;
if (lastOut && !lastOut.errorMessage) {
  console.log("\nfinal output:");
  console.log(JSON.stringify(lastOut, null, 2));
}
process.exit(failed ? 1 : 0);

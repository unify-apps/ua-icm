#!/usr/bin/env node
// DEPLOY helper. The only sanctioned way to put an automation in front of
// callers - and the gate that makes the test suite non-optional.
//
//   node scripts/deploy.mjs <workflowId> "what changed and who approved"
//
// It REFUSES to deploy unless, in this order:
//   1. tests/<workflowId>.json exists                 (a suite must exist)
//   2. scripts/regress.mjs <workflowId> is all green  (it must pass)
//   3. ua.mjs validate <workflowId> prints clean      (builder validation)
//   4. scripts/lint.mjs <workflowId> prints clean     (kit rules)
// then it deploys, then it VERIFIES by reading deploymentState back and
// comparing workflowVersion to the draft version. A 200 from the deploy
// endpoint is not proof and is never treated as proof.
//
// There is no bypass flag on purpose. Following the ua-write.mjs precedent:
// if you genuinely must ship without a suite, edit this file deliberately
// and say so in the commit - so that skipping is a visible act, not a
// shortcut nobody sees.
//
// Deploys to PRODUCTION only with an explicit `--env tool` on the command line.
// Was orbit-only until 2026-09-05; the product now lives on tool prod, and a
// deploy path that cannot reach it means nothing built there is ever reachable
// by a caller. The four gates below are unchanged and are the whole point —
// they matter more on prod, not less, so nothing here was relaxed to allow it.
//
// The gates run as SUBPROCESSES, and each is told which environment to check.
// Getting that wrong would be the worst bug this file could have: gates green
// against orbit, deploy landing on prod.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveEnv } from "./env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const die = (m) => { console.error(`\nREFUSED: ${m}\n`); process.exit(1); };

const { env, baseUrl, headers, args: argv } = resolveEnv({ write: true });

const [id, notes] = argv;
if (!id) die("usage: deploy.mjs <workflowId> \"deployment notes\" [--env orbit|tool]");
if (!notes || notes.trim().length < 10) {
  die("deploymentNotes are required and must say what changed and who approved it");
}

const run = (script, args) => {
  try {
    return execFileSync("node", [path.join(ROOT, "scripts", script), ...args],
      { encoding: "utf8", cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return `${e.stdout ?? ""}${e.stderr ?? ""}__FAILED__`;
  }
};

// ---- gate 1: a suite must exist
const suitePath = path.join(ROOT, "tests", `${id}.json`);
if (!fs.existsSync(suitePath)) {
  die(`no regression suite at tests/${id}.json.\n` +
      `  Every deployed automation owns a suite - that is what makes "it works"\n` +
      `  a fact instead of a claim. Write one (happy path, the all-empty-strings\n` +
      `  payload, and for anything that CREATES, the same payload sent twice),\n` +
      `  then deploy.`);
}

// ---- gate 2: it must pass
console.log(`gate 1/4  suite exists                tests/${id}.json`);
console.log(`target    ${env}  ${baseUrl}`);
process.stdout.write("gate 2/4  running the suite ...        ");
const regress = run("regress.mjs", [id, "--env", env]);
if (!regress.includes("all green")) {
  console.log("RED");
  die(`the suite is not green, so this automation is not ready for callers.\n\n` +
      regress.split("\n").filter((l) => /fail|red|error|FAILED/i.test(l)).slice(0, 12).join("\n"));
}
console.log("all green");

// ---- gates 3 and 4: the builder's view and the kit's rules
for (const [n, script, label] of [[3, "ua.mjs", "validate"], [4, "lint.mjs", "lint"]]) {
  process.stdout.write(`gate ${n}/4  ${label.padEnd(30)}`);
  const out = script === "ua.mjs"
    ? run(script, ["validate", id, "--env", env])
    : run(script, [id, "--env", env]);
  if (!out.includes("clean")) {
    console.log("NOT CLEAN");
    die(`${label} is not clean. The runtime, the validator and the builder see\n` +
        `  DIFFERENT layers - a green suite does not cover the other two.\n\n${out.slice(0, 1200)}`);
  }
  console.log("clean");
}

// ---- deploy
const fetchWf = async () => {
  const r = await fetch(`${baseUrl}/api/workflow-definition/${id}`, { headers });
  if (!r.ok) die(`could not read the workflow: HTTP ${r.status}`);
  return r.json();
};

const before = await fetchWf();
console.log(`\ndeploying "${before.name}" draft v${before.version} to ${env} ...`);
const res = await fetch(`${baseUrl}/api/workflow-definition/${id}/deploy`, {
  method: "POST", headers, body: JSON.stringify({ deploymentNotes: notes }),
});
if (!res.ok) die(`deploy failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);

// ---- verify: the 200 above proves nothing
const after = await fetchWf();
const ds = after.deploymentState ?? {};
if (ds.status !== "DEPLOYED" || ds.workflowVersion !== after.version) {
  die(`the deploy reported success but deploymentState does not agree:\n` +
      `  draft version    ${after.version}\n` +
      `  deployed version ${ds.workflowVersion} (${ds.status})\n` +
      `  Do NOT tell anyone this is live.`);
}
console.log(`LIVE: "${after.name}" workflowVersion ${ds.workflowVersion} = draft v${after.version}`);
console.log(`      verified by reading deploymentState back, not by the deploy's 200.`);

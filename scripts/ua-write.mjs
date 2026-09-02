#!/usr/bin/env node
// WRITE helper for the UnifyApps platform. Unlike scripts/ua.mjs, this one
// CHANGES things. Keep it small and boring on purpose.
//
//   node scripts/ua-write.mjs update <workflowId> <definition.json>
//
// It POSTs the given definition to /api/workflow-definition/update/{id}.
// The definition must be a complete workflow object as returned by
// `ua.mjs fetch` - this is a full replace, not a patch, which is exactly why
// it can do things the copilot cannot (removing a key, deleting a node).
//
// Snapshot and commit before using it. There is no undo here.
//
// Refuses to run against the `tool` (production) environment. Production is
// read-only unless a human changes this file deliberately.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const vars = {};
for (const line of fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m && !line.trim().startsWith("#")) vars[m[1]] = m[2];
}

const args = process.argv.slice(2);
const envFlagIdx = args.indexOf("--env");
let envName = null;
if (envFlagIdx !== -1) {
  envName = args[envFlagIdx + 1];
  args.splice(envFlagIdx, 2);
}
envName = envName || vars.UA_DEFAULT_ENV || "orbit";
if (envName === "tool") {
  die("refusing to write to tool (production). This script only writes to orbit.");
}
if (envName !== "orbit") die(`unknown env "${envName}"`);

const baseUrl = vars.UA_ORBIT_URL;
const cookie = vars.UA_ORBIT_COOKIE;
if (!baseUrl || !cookie) die("missing UA_ORBIT_URL or UA_ORBIT_COOKIE in .env.local");

const [command, id, file] = args;
if (command !== "update" || !id || !file) {
  die('usage: node scripts/ua-write.mjs update <workflowId> <definition.json>');
}

const definition = JSON.parse(fs.readFileSync(file, "utf8"));
if (definition.id !== id) {
  die(`definition.id is "${definition.id}" but you asked to update "${id}" - refusing`);
}

// Edge metadata the builder canvas needs. The API accepts edges without it
// and reads them straight back, so a JSON diff will not catch the omission -
// but the canvas then renders only the trunk and every node past a branch
// becomes invisible. Fill it in rather than relying on remembering.
const nodeType = Object.fromEntries((definition.nodes ?? []).map((n) => [n.id, n.type]));
let filled = 0;
for (const e of definition.edges ?? []) {
  if (!e.id) {
    e.id = `${e.type}@${e.fromNodeId}@${e.toNodeId}`;
    filled++;
  }
  if (nodeType[e.fromNodeId] === "IF_ELSE" && !e.name) {
    e.name = e.type === "if" ? "yes" : "no";
    filled++;
  }
}

console.log(`updating ${id} on ${envName} from ${file}`);
console.log(`  ${definition.nodes?.length ?? 0} nodes, ${definition.edges?.length ?? 0} edges, version ${definition.version}`);
if (filled) console.log(`  filled in ${filled} missing edge id/name field(s)`);

const res = await fetch(`${baseUrl}/api/workflow-definition/update/${id}`, {
  method: "POST",
  headers: { cookie: `_at=${cookie}`, "content-type": "application/json" },
  body: JSON.stringify(definition),
});
const text = await res.text();
if (!res.ok) die(`HTTP ${res.status}: ${text.slice(0, 800)}`);
console.log(`ok (HTTP ${res.status})`);
console.log("Now re-fetch and diff - do not assume this landed as intended.");

#!/usr/bin/env node
// CREATE an automation from a snapshot. The kit could read and update workflow
// definitions but never make one, so replicating an automation onto a second
// environment had no sanctioned path at all - `ua-write.mjs` only ever POSTs to
// `update/{id}`, which needs an id that does not exist yet.
//
//   node scripts/ua-automation.mjs plan   <snapshot.json> [--env orbit|tool]
//   node scripts/ua-automation.mjs create <snapshot.json> [--env orbit|tool]
//
// The endpoint is `POST /api/workflow-definition` ("Create Workflow Definition"
// in the platform's own generated client, www/packages/network/src/generated/
// workflow-definition-rest-api). Verified there rather than guessed.
//
// WHAT IT STRIPS, and why. A snapshot is what the server returned, so it carries
// the server's own bookkeeping. Sending those back on a create either collides
// with the source environment or lies about provenance:
//
//   id, version                 the target mints its own
//   createdTime, modifiedTime   timestamps belong to the source
//   ownerUserId, lastModifiedBy, lastPlatformUpdate*   the caller is the owner here
//   deploymentState             a deployed pointer from another environment;
//                               deploying on the target is a separate, gated act
//
// WHAT PORTS CLEANLY, checked before this script was written: storage nodes name
// their objects by NAME ("object_type":"Period"), not by an environment id, so a
// definition moves as long as the objects exist on the target under the same
// names. These three carry no connectionIds and no CallWorkflow references.
//
// Tags come from kit.config.json, never from the snapshot - membership is by TAG,
// and copying a tag out of a file is how a snapshot from the wrong product ends
// up in the family.
//
// Created DRAFT. It never deploys: callers only hit the deployed copy, and
// deploying is `deploy.mjs` with its four gates and an explicit human yes.
//
// Writes to PRODUCTION only with an explicit `--env tool` on the command line.

import fs from "node:fs";
import path from "node:path";
import { resolveEnv } from "./env.mjs";
import { AUTOMATION_TAGS, TEST_TAG } from "./kit-config.mjs";

const die = (m) => { console.error(`error: ${m}`); process.exit(1); };

const { env, baseUrl, headers: H, args: argv } = resolveEnv({ write: true });
async function api(pathname, body) {
  const res = await fetch(baseUrl + pathname, {
    method: body === undefined ? "GET" : "POST",
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) die(`${pathname} -> HTTP ${res.status}: ${text.slice(0, 600)}`);
  return text ? JSON.parse(text) : {};
}

// Server-owned. See the header for why each one goes.
const STRIP = [
  "id", "version", "createdTime", "modifiedTime", "ownerUserId",
  "lastModifiedBy", "lastPlatformUpdateBy", "lastPlatformUpdateOn",
  "deploymentState",
];

const [cmd, file, ...rest] = argv;
if (!cmd || !file) die("usage: ua-automation.mjs plan|create <snapshot.json> [--env orbit|tool] [--test]");
const test = rest.includes("--test");

const snap = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
if (!snap.name) die("snapshot has no `name`");
if (!Array.isArray(snap.nodes) || !snap.nodes.length) die("snapshot has no `nodes`");

const body = { ...snap };
for (const k of STRIP) delete body[k];
body.tags = test ? [TEST_TAG] : [...AUTOMATION_TAGS];
body.lcName = String(snap.name).toLowerCase();

if (cmd === "plan") {
  console.log(`target      ${env} (${baseUrl})`);
  console.log(`name        ${body.name}`);
  console.log(`tags        ${JSON.stringify(body.tags)}`);
  console.log(`nodes/edges ${body.nodes.length}/${(body.edges || []).length}`);
  console.log(`stripped    ${STRIP.filter((k) => k in snap).join(", ") || "(nothing)"}`);
  console.log(`keys sent   ${Object.keys(body).sort().join(", ")}`);
  process.exit(0);
}
if (cmd !== "create") die(`unknown command "${cmd}"`);

// Refuse a duplicate by NAME on the target. Two automations with one name is the
// state the kit's own rules call out as unsafe: `find_automation` cannot choose,
// and a caller resolving by name gets whichever answered first.
// Platform entities take the standard_entities dialect - {op, values:[{field, op,
// values}]} - NOT the storage {operator, filters:[...]} shape. The wrong one answers
// HTTP 500 "Filter$Op ... op is null" at run time, which is the failure
// notes/runtime-facts.md and CLAUDE.md both name. Copied from ua.mjs `search --tag`.
const listed = await api("/api/workflow-definition/listPermissible", {
  filter: { op: "AND", values: [{ field: "tags", op: "IN", values: body.tags }] },
  page: { limit: 200 },
  includeTotalHits: true,
});
const rows = listed.objects ?? [];
const clash = rows.find((r) => r.name === body.name);
if (clash) die(`"${body.name}" already exists on ${env} as ${clash.id} - this script only CREATES`);

const out = await api("/api/workflow-definition", body);
console.log(`created on ${env}: ${out.id}  "${out.name}"  tags=${JSON.stringify(out.tags)}`);
console.log(`  nodes=${(out.nodes || []).length} edges=${(out.edges || []).length} version=${out.version ?? "(none)"}`);
console.log(`  DRAFT - not deployed. Callers only ever hit the deployed copy.`);
console.log(`next: node scripts/ua.mjs validate ${out.id} --env ${env}`);

#!/usr/bin/env node
// Push build/calculate-credits.json onto the live draft.
//
// It re-FETCHES the definition first rather than reading the last snapshot. The update
// endpoint is optimistic-locked on `version`, and a snapshot goes stale the moment
// anything writes - including this script's own previous run. Pushing a stale version
// answers HTTP 500 "... is stale, current version is N" and changes nothing, which is
// easy to miss when the next command in the chain runs anyway and quietly exercises the
// OLD definition.
//
//   node scripts/push-calculate-credits.mjs <workflowId> --env tool

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveEnv, ROOT } from "./env.mjs";

const die = (m) => { console.error(`error: ${m}`); process.exit(1); };
const { baseUrl, headers, args } = resolveEnv({ write: true });
const id = args[0] || die("usage: push-calculate-credits.mjs <workflowId> --env tool");

const res = await fetch(`${baseUrl}/api/workflow-definition/${id}`, { headers });
if (!res.ok) die(`fetch ${id} -> HTTP ${res.status}`);
const live = await res.json();

const built = JSON.parse(fs.readFileSync(path.join(ROOT, "build", "calculate-credits.json"), "utf8"));
const next = { ...live, nodes: built.nodes, edges: built.edges, description: built.description };
const tmp = path.join(ROOT, "build", "calculate-credits.update.json");
fs.writeFileSync(tmp, JSON.stringify(next, null, 1));

console.log(`live version ${live.version}, ${live.nodes.length} nodes -> pushing ${built.nodes.length}`);
execFileSync("node", [path.join(ROOT, "scripts", "ua-write.mjs"), "update", id, tmp, "--env", "tool"], { stdio: "inherit" });

// Never assume a write landed: read it back and assert the graph is what was sent.
const back = await (await fetch(`${baseUrl}/api/workflow-definition/${id}`, { headers })).json();
const B = new Map(built.nodes.map((n) => [n.id, n]));
const L = new Map(back.nodes.map((n) => [n.id, n]));
let bad = 0;
for (const [nid, b] of B) {
  const l = L.get(nid);
  if (!l) { console.error(`  MISSING on server: ${nid}`); bad++; continue; }
  if (l.groupId !== b.groupId) { console.error(`  groupId drift ${nid}`); bad++; }
  const lp = Object.keys(l.inputs?.parameters ?? {}).sort().join(",");
  const bp = Object.keys(b.inputs?.parameters ?? {}).sort().join(",");
  if (lp !== bp) { console.error(`  parameter drift ${nid}: server "${lp}" vs built "${bp}"`); bad++; }
  if ((l.inputs?.code ?? "") !== (b.inputs?.code ?? "")) { console.error(`  CODE drift ${nid}`); bad++; }
}
for (const nid of L.keys()) if (!B.has(nid)) { console.error(`  EXTRA on server: ${nid}`); bad++; }
if (bad) die(`${bad} difference(s) after the write - the draft is NOT what was built`);
console.log(`round-trip clean at version ${back.version}: ${B.size} nodes, code and parameters identical`);

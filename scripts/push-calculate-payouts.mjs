#!/usr/bin/env node
// Push build/calculate-payouts.json onto the live draft of ICM | Calculate Payouts.
//
// Re-FETCHES the definition first (the update endpoint is optimistic-locked on version),
// writes through ua-write.mjs, then reads it back and asserts groups, parameters and code
// are exactly what was built. Same mechanism as push-calculate-credits.mjs.
//
//   node scripts/push-calculate-payouts.mjs <workflowId> --env tool

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveEnv, ROOT } from "./env.mjs";

const die = (m) => { console.error(`error: ${m}`); process.exit(1); };
const { baseUrl, headers, args } = resolveEnv({ write: true });
const id = args[0] || die("usage: push-calculate-payouts.mjs <workflowId> --env tool");

const res = await fetch(`${baseUrl}/api/workflow-definition/${id}`, { headers });
if (!res.ok) die(`fetch ${id} -> HTTP ${res.status}`);
const live = await res.json();

const built = JSON.parse(fs.readFileSync(path.join(ROOT, "build", "calculate-payouts.json"), "utf8"));
const next = { ...live, nodes: built.nodes, edges: built.edges, description: built.description };
const tmp = path.join(ROOT, "build", "calculate-payouts.update.json");
fs.writeFileSync(tmp, JSON.stringify(next, null, 1));

console.log(`live version ${live.version}, ${live.nodes.length} nodes -> pushing ${built.nodes.length}`);
execFileSync("node", [path.join(ROOT, "scripts", "ua-write.mjs"), "update", id, tmp, "--env", "tool"], { stdio: "inherit" });

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

#!/usr/bin/env node
// Read-only helper for the UnifyApps platform.
// Auth comes from .env.local (cookie named _at on the platform).
// Commands (all read-only, nothing here can change the platform):
//   node scripts/ua.mjs whoami
//   node scripts/ua.mjs validate <id> [...]    builder violations for current defs
//   node scripts/ua.mjs search <text>          find automations by name
//   node scripts/ua.mjs search --tag <tag>     find automations by tag
//   node scripts/ua.mjs fetch <id>             print one automation as JSON
//   node scripts/ua.mjs snap <id> [<id>...]    save automations into snapshots/
//   node scripts/ua.mjs types --tag <tag>      list object types by tag
//   node scripts/ua.mjs snap-types --tag <tag> save those schemas into snapshots/
//   node scripts/ua.mjs snap-types <id> [...]  save specific schemas
// Pick platform with --env orbit|tool (default from UA_DEFAULT_ENV).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvFile() {
  const file = path.join(ROOT, ".env.local");
  if (!fs.existsSync(file)) {
    die(`.env.local not found at ${file} - create it and paste cookies first`);
  }
  const vars = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && !line.trim().startsWith("#")) vars[m[1]] = m[2];
  }
  return vars;
}

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const envFlagIdx = args.indexOf("--env");
let envName = null;
if (envFlagIdx !== -1) {
  envName = args[envFlagIdx + 1];
  args.splice(envFlagIdx, 2);
}
const [command, ...rest] = args;

const vars = loadEnvFile();
envName = envName || vars.UA_DEFAULT_ENV || "orbit";
if (envName !== "orbit" && envName !== "tool") die(`unknown env "${envName}", use orbit or tool`);
const baseUrl = vars[envName === "orbit" ? "UA_ORBIT_URL" : "UA_TOOL_URL"];
const cookie = vars[envName === "orbit" ? "UA_ORBIT_COOKIE" : "UA_TOOL_COOKIE"];
if (!baseUrl || !cookie) die(`missing url or cookie for env "${envName}" in .env.local`);

async function api(pathname, body) {
  const res = await fetch(baseUrl + pathname, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie: `_at=${cookie}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    die(`not logged in on ${envName} (HTTP ${res.status}) - cookie in .env.local is stale, paste a fresh one`);
  }
  if (!res.ok) die(`${pathname} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function snapshotDir() {
  const dir = path.join(ROOT, "snapshots", envName, "automations");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rebuildIndex(dir) {
  const rows = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    rows.push(`| ${d.id} | ${d.name ?? "?"} | ${d.nodes?.length ?? 0} | ${new Date(d.modifiedTime ?? 0).toISOString().slice(0, 10)} |`);
  }
  const md = [
    `# Automation snapshots (${envName})`,
    "",
    "Rebuilt automatically by `scripts/ua.mjs snap`. One JSON file per automation, named by id.",
    "",
    "| id | name | nodes | last modified |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "INDEX.md"), md);
}

// Entity types (objects) are listed via the aggregation API:
// group STANDARD + entityType "EntityType" (backend: EntityTypeAggregationHandler).
// Projections are required or the response comes back empty.
async function listEntityTypes(tag) {
  const d = await api("/api/aggregation", {
    group: "STANDARD",
    entityType: "EntityType",
    projections: [
      { name: "id", aggregationFunction: "GROUP" },
      { name: "name", aggregationFunction: "GROUP" },
      { name: "tags", aggregationFunction: "GROUP" },
    ],
    filter: { op: "AND", values: [{ field: "tags", op: "IN", values: [tag] }] },
    page: { limit: 500 },
    includeTotalHits: true,
  });
  return (d.objects ?? []).map((o) => o.columns ?? o);
}

function typesSnapshotDir() {
  const dir = path.join(ROOT, "snapshots", envName, "entity-types");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rebuildTypesIndex(dir) {
  const rows = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const fields = Object.keys(d.schema?.schema?.properties ?? {}).length;
    rows.push(`| ${d.id} | ${d.name ?? "?"} | ${(d.tags ?? []).join(", ")} | ${fields} |`);
  }
  const md = [
    `# Entity type (object) snapshots (${envName})`,
    "",
    "Rebuilt automatically by `scripts/ua.mjs snap-types`. One JSON per object type.",
    "",
    "| id | name | tags | schema fields |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "INDEX.md"), md);
}

const commands = {
  async validate() {
    // validate <id> [<id>...] - the machine version of opening the builder.
    // POSTs each CURRENT definition to /api/workflow-definition/validate
    // (read-only, mutates nothing) and prints every violation. Run after
    // EVERY change, agent-made or direct - a graph can pass test runs and
    // still render dangling/incomplete to humans in the builder.
    if (!rest.length) die("usage: validate <id> [<id>...]");
    let bad = 0;
    for (const id of rest) {
      const wf = await api(`/api/workflow-definition/${id}`);
      const violations = await api(`/api/workflow-definition/validate?strict=true`, wf);
      if (!violations.length) {
        console.log(`  clean    ${id}  ${wf.name ?? ""}`);
        continue;
      }
      bad++;
      console.log(`  DIRTY    ${id}  ${wf.name ?? ""} - ${violations.length} violation(s):`);
      for (const v of violations) {
        for (const inner of v.innerViolations ?? [{ message: v.message ?? JSON.stringify(v) }]) {
          console.log(`             ${v.id ?? "?"}: ${inner.id ?? ""} ${inner.message ?? JSON.stringify(inner)}`);
        }
      }
    }
    if (bad) {
      console.log(`${bad} automation(s) have builder violations - not done until clean`);
      process.exit(1);
    }
  },

  async whoami() {
    const d = await api("/api/entity-type/getLoggedInUser");
    console.log(`logged in on ${envName} (${baseUrl}) - server answered with schema id "${d.id}"`);
  },

  async search() {
    // search --tag <tag>  -> automations by tag (membership is by TAG, never by name)
    // search <text>       -> name contains <text> (loose, for exploring)
    let filter;
    let label;
    if (rest[0] === "--tag") {
      if (!rest[1]) die("usage: search --tag <tag>");
      filter = { op: "AND", values: [{ field: "tags", op: "IN", values: [rest[1]] }] };
      label = `tag "${rest[1]}"`;
    } else if (rest[0]) {
      filter = { field: "name", op: "ICONTAINS", values: [rest[0]] };
      label = `name containing "${rest[0]}"`;
    } else {
      die("usage: search <text> | search --tag <tag>");
    }
    const d = await api("/api/workflow-definition/listPermissible", {
      filter,
      page: { limit: 100 },
      includeTotalHits: true,
    });
    const list = d.objects ?? [];
    console.log(`${d.totalHits ?? list.length} match(es) for ${label} on ${envName}:`);
    for (const wf of list) {
      console.log(`  ${wf.id}  ${wf.name}  (${wf.nodes?.length ?? 0} nodes)`);
    }
  },

  async fetch() {
    const id = rest[0];
    if (!id) die("usage: fetch <id>");
    const d = await api(`/api/workflow-definition/${id}`);
    console.log(JSON.stringify(d, null, 2));
  },

  async snap() {
    if (rest.length === 0) die("usage: snap <id> [<id>...]");
    const dir = snapshotDir();
    for (const id of rest) {
      const d = await api(`/api/workflow-definition/${id}`);
      const file = path.join(dir, `${id}.json`);
      fs.writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
      console.log(`saved ${path.relative(ROOT, file)}  (${d.name}, ${d.nodes?.length ?? 0} nodes)`);
    }
    rebuildIndex(dir);
    console.log(`updated ${path.relative(ROOT, path.join(dir, "INDEX.md"))}`);
  },
  async inventory() {
    // inventory --tag <tag>   -> automations with that tag + their deploy state
    // inventory               -> every automation we can see (no deploy probing)
    let filter;
    let probeDeploy = false;
    if (rest[0] === "--tag") {
      if (!rest[1]) die("usage: inventory [--tag <tag>]");
      filter = { op: "AND", values: [{ field: "tags", op: "IN", values: [rest[1]] }] };
      probeDeploy = true;
    }
    const d = await api("/api/workflow-definition/listPermissible", {
      ...(filter ? { filter } : {}),
      page: { limit: 500 },
      includeTotalHits: true,
    });
    const list = (d.objects ?? []).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
    const rows = [];
    for (const wf of list) {
      let deploy = "-";
      if (probeDeploy) {
        // A deployed copy lives at deployed-workflow/{id}. Compare its
        // modifiedTime with the draft's to spot stale deployments.
        try {
          const res = await fetch(`${baseUrl}/api/workflow-definition/deployed-workflow/${wf.id}?latest=true`, {
            headers: { cookie: `_at=${cookie}` },
          });
          const dep = JSON.parse(await res.text());
          if (!res.ok || !dep.nodes) deploy = "NOT deployed";
          // Same nodes+edges content = current, regardless of timestamps
          // (a deploy bumps the draft version right after writing the copy).
          else if (
            JSON.stringify(dep.nodes) === JSON.stringify(wf.nodes) &&
            JSON.stringify(dep.edges) === JSON.stringify(wf.edges)
          ) deploy = "deployed, current";
          else deploy = "deployed, STALE (draft differs)";
        } catch {
          deploy = "NOT deployed";
        }
      }
      rows.push({ id: wf.id, name: wf.name, tags: (wf.tags ?? []).join(","), version: wf.version, nodes: wf.nodes?.length ?? 0, deploy });
      console.log(`  ${wf.id}  v${wf.version}  ${String(wf.nodes?.length ?? 0).padStart(2)} nodes  ${probeDeploy ? "[" + deploy + "]  " : ""}${wf.name}`);
    }
    console.log(`${d.totalHits ?? list.length} automation(s)${d.totalHits > list.length ? " (showing first 500)" : ""} on ${envName}`);
    const dir = snapshotDir();
    const md = [
      `# Automation inventory (${envName})`,
      "",
      `Rebuilt by \`scripts/ua.mjs inventory${probeDeploy ? " --tag " + rest[1] : ""}\` on ${new Date().toISOString().slice(0, 10)}.`,
      "",
      "| id | name | tags | draft version | nodes | deploy state |",
      "| --- | --- | --- | --- | --- | --- |",
      ...rows.map((r) => `| ${r.id} | ${r.name} | ${r.tags} | ${r.version} | ${r.nodes} | ${r.deploy} |`),
      "",
    ].join("\n");
    const invName = probeDeploy ? `INVENTORY-${rest[1]}.md` : "INVENTORY.md";
    fs.writeFileSync(path.join(dir, invName), md);
    console.log(`wrote ${path.relative(ROOT, path.join(dir, invName))}`);
  },

  async drift() {
    // drift --tag <tag> : compare the platform against our committed
    // snapshots - shows NEW / CHANGED / SAME / GONE per automation.
    if (rest[0] !== "--tag" || !rest[1]) die("usage: drift --tag <tag>");
    const d = await api("/api/workflow-definition/listPermissible", {
      filter: { op: "AND", values: [{ field: "tags", op: "IN", values: [rest[1]] }] },
      page: { limit: 500 },
    });
    const live = new Map((d.objects ?? []).map((w) => [w.id, w]));
    const dir = snapshotDir();
    const essence = (w) => JSON.stringify({ name: w.name, nodes: w.nodes, edges: w.edges });
    let changes = 0;
    for (const [id, w] of live) {
      const file = path.join(dir, `${id}.json`);
      if (!fs.existsSync(file)) {
        changes++;
        console.log(`  NEW      ${id}  ${w.name}  (v${w.version}, ${w.nodes?.length ?? 0} nodes) - no snapshot yet`);
        continue;
      }
      const snap = JSON.parse(fs.readFileSync(file, "utf8"));
      if (essence(snap) !== essence(w)) {
        changes++;
        console.log(`  CHANGED  ${id}  ${w.name}  (snapshot v${snap.version} -> platform v${w.version})`);
      } else {
        console.log(`  same     ${id}  ${w.name}`);
      }
    }
    for (const f of fs.readdirSync(dir).filter((f) => /^[0-9a-f]{24}\.json$/.test(f))) {
      const snap = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if ((snap.tags ?? []).includes(rest[1]) && !live.has(snap.id)) {
        changes++;
        console.log(`  GONE     ${snap.id}  ${snap.name} - snapshot exists but not on the platform`);
      }
    }
    console.log(changes === 0 ? "no drift - snapshots match the platform" : `${changes} automation(s) drifted - snap the changed ones and review the diffs`);
  },

  async registry() {
    // registry --tag <tag> [--tag <tag>...] : every automation's callable
    // contract (inputs/outputs) in one page, for the design step's
    // "what already exists that I can call?".
    const tags = [];
    for (let i = 0; i < rest.length; i += 2) {
      if (rest[i] !== "--tag" || !rest[i + 1]) die("usage: registry --tag <tag> [--tag <tag>...]");
      tags.push(rest[i + 1]);
    }
    if (tags.length === 0) die("usage: registry --tag <tag> [--tag <tag>...]");
    const seen = new Map();
    for (const tag of tags) {
      const d = await api("/api/workflow-definition/listPermissible", {
        filter: { op: "AND", values: [{ field: "tags", op: "IN", values: [tag] }] },
        page: { limit: 500 },
      });
      for (const w of d.objects ?? []) seen.set(w.id, w);
    }
    const schemaLine = (props) =>
      Object.entries(props ?? {})
        .map(([k, v]) => `${k}${v.type ? ":" + (v.type === "array" ? "array" : v.type) : ""}`)
        .join(", ") || "-";
    const rows = [];
    for (const w of [...seen.values()].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))) {
      const start = (w.nodes ?? []).find((n) => n.type === "START");
      const callable = start?.context?.resourceName === "callables_from_automation";
      rows.push({
        id: w.id,
        name: w.name,
        tags: (w.tags ?? []).join(","),
        trigger: callable ? "CALLABLE" : (start?.context?.resourceName ?? "?"),
        inputs: callable ? schemaLine(start?.inputs?.setup?.properties) : "-",
        outputs: callable ? schemaLine(start?.inputs?.result?.properties) : "-",
        description: w.description ?? "",
      });
      console.log(`  ${w.id}  ${callable ? "[callable]" : "[" + (start?.context?.resourceName ?? "?") + "]"}  ${w.name}`);
    }
    const dir = snapshotDir();
    const md = [
      `# Automation registry (${envName}) - what you can call`,
      "",
      `Every callable here can be invoked from any other automation (CallWorkflow`,
      `node). Rebuilt by \`scripts/ua.mjs registry ${tags.map((t) => "--tag " + t).join(" ")}\` on ${new Date().toISOString().slice(0, 10)}.`,
      "",
      "| name | id | tags | trigger | inputs | outputs |",
      "| --- | --- | --- | --- | --- | --- |",
      ...rows.map((r) => `| ${r.name} | ${r.id} | ${r.tags} | ${r.trigger} | ${r.inputs} | ${r.outputs} |`),
      "",
      "## Descriptions",
      "",
      ...rows.filter((r) => r.description).map((r) => `- **${r.name}**: ${r.description}`),
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "REGISTRY.md"), md);
    console.log(`${rows.length} automation(s); wrote ${path.relative(ROOT, path.join(dir, "REGISTRY.md"))}`);
  },

  async types() {
    if (rest[0] !== "--tag" || !rest[1]) die("usage: types --tag <tag>");
    const list = await listEntityTypes(rest[1]);
    console.log(`${list.length} object type(s) tagged "${rest[1]}" on ${envName}:`);
    for (const t of list) console.log(`  ${t.id}  ${t.name}  ${JSON.stringify(t.tags)}`);
  },

  async "snap-types"() {
    let ids;
    if (rest[0] === "--tag") {
      if (!rest[1]) die("usage: snap-types --tag <tag>");
      ids = (await listEntityTypes(rest[1])).map((t) => t.id);
      if (ids.length === 0) die(`no object types tagged "${rest[1]}" on ${envName}`);
    } else if (rest.length > 0) {
      ids = rest;
    } else {
      die("usage: snap-types --tag <tag> | snap-types <id> [<id>...]");
    }
    const dir = typesSnapshotDir();
    for (const id of ids) {
      const d = await api(`/api/entity-type?entityType=${encodeURIComponent(id)}`);
      const file = path.join(dir, `${id}.json`);
      fs.writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
      console.log(`saved ${path.relative(ROOT, file)}  (${d.name})`);
    }
    rebuildTypesIndex(dir);
    console.log(`updated ${path.relative(ROOT, path.join(dir, "INDEX.md"))}`);
  },
};

if (!command || !commands[command]) {
  console.log(
    "commands: whoami | validate <id> [<id>...] | search <text> | search --tag <tag> | fetch <id> | snap <id> [<id>...] | types --tag <tag> | snap-types --tag <tag> | snap-types <id> [...]   (add --env orbit|tool)",
  );
  process.exit(command ? 1 : 0);
}
await commands[command]();

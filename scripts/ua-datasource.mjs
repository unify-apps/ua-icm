#!/usr/bin/env node
// CREATE a page data source — the thing that lets a PAGE call a deployed
// automation.
//
//   node scripts/ua-datasource.mjs plan   <spec.json>   print the body, call nothing
//   node scripts/ua-datasource.mjs create <spec.json>   POST it
//
// WHY THIS EXISTS, and why it is not just a call to the page-builder MCP tool.
//
// `create_data_source` in the devkit's llm-tools hardcodes
// `entityType: 'e_data_source_deployed'` (page-builder/actions/dataSources.ts,
// commented "[VERIFIED export] — every real DS export carries this literal").
// That literal is true of the platform it was verified against. It is NOT true
// of orbit, where the type does not exist:
//
//   GET /api/entity-type?entityType=e_data_source_deployed -> HTTP 200, EMPTY body
//   GET /api/entity-type?entityType=e_data_source          -> the real definition
//
// so every create through that tool fails with
// "ENTITY_TYPE with id e_data_source_deployed not found ... check if you have
// the permissions", which reads like an entitlement problem and is not one.
//
// The lesson is the reason this script PROBES instead of hardcoding: it asks
// the platform which of the two types exists and uses that one, and says which
// it used. A kit that hardcodes the same literal would inherit the same bug.
//
// CREATING A ROW IS NOT ENOUGH. The row it writes is a DRAFT. A deployed app runs as
// an application user, and that path resolves the DEPLOYED data source, so the app sees
// `forbidden datasource: not found` until the APPLICATION is deployed. A call from this
// script takes the draft path and succeeds, which makes it easy to believe the binding
// works when it does not. `ua-datasource.mjs deployed <id>` is the question that
// actually answers it.
//
// Runs against orbit by default. Production requires BOTH UA_DEFAULT_ENV="tool"
// and UA_ALLOW_PROD_WRITES="true" in .env.local.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_ID } from "./kit-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const die = (m) => { console.error(`error: ${m}`); process.exit(1); };

const vars = {};
for (const line of fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m && !line.trim().startsWith("#")) vars[m[1]] = m[2];
}
const [cmd, file] = process.argv.slice(2);
if (!cmd || !file) die("usage: ua-datasource.mjs plan|create <spec.json> | deployed <dataSourceId>");

const env = vars.UA_DEFAULT_ENV || "orbit";
if (env !== "orbit" && env !== "tool") die(`unknown env "${env}", use orbit or tool`);
// Production writes are a STANDING, separate opt-in. Switching UA_DEFAULT_ENV to
// "tool" so the read scripts can see prod must never be enough to write it too, so
// the env flip and the write permission are two different keys on purpose.
// `plan` and `deployed` do not write, so they do not need the write opt-in.
if (env === "tool" && cmd === "create" && vars.UA_ALLOW_PROD_WRITES !== "true") {
  die('refusing to create data sources on tool (production): set UA_ALLOW_PROD_WRITES="true" in .env.local to allow it');
}
const baseUrl = env === "tool" ? vars.UA_TOOL_URL : vars.UA_ORBIT_URL;
const cookie = env === "tool" ? vars.UA_TOOL_COOKIE : vars.UA_ORBIT_COOKIE;
if (!baseUrl || !cookie) die(`missing url or cookie for env "${env}"`);
if (env === "tool" && cmd === "create")
  console.error("! tool (PRODUCTION) - this changes the data model for everyone");
const H = { cookie: `_at=${cookie}`, "content-type": "application/json" };

/** Ask the platform which data-source entity type it actually has. */
async function resolveEntityType() {
  for (const t of ["e_data_source_deployed", "e_data_source"]) {
    const res = await fetch(`${baseUrl}/api/entity-type?entityType=${t}`, { headers: H });
    const body = (await res.text()).trim();
    // A missing type answers 200 with an EMPTY body rather than a 404, which is
    // why "did the request succeed" is the wrong question to ask here.
    if (res.ok && body.length > 0 && body.includes(`"id"`)) return { type: t, probed: body.length };
  }
  die("neither e_data_source_deployed nor e_data_source exists on this platform");
}

function build(spec, entityType) {
  for (const k of ["name", "pageId", "automationId"])
    if (!spec[k]) die(`spec needs \`${k}\``);
  return {
    entityType,
    properties: {
      name: spec.name,
      type: "APPLICATION",
      interfacePageId: spec.pageId,
      interfaceId: spec.interfaceId || APP_ID,
      // Copied from a real resource via get_data_source_options, never invented:
      // a nearly-right resourceName fetches nothing and reports nothing.
      context: {
        type: "APPLICATION",
        appName: "callables",
        resourceName: "callables_call_automation",
        resourceVersion: spec.resourceVersion ?? 2832,
      },
      inputs: {
        automationId: spec.automationId,
        synchronous: spec.synchronous !== false,
        parameters: spec.parameters ?? {},
      },
      advancedOptions: {
        runBehaviour: spec.runBehaviour ?? "automatic",
        timing: { runQueryOnPageLoad: spec.runOnPageLoad !== false },
      },
    },
  };
}

const { type: entityType } = await resolveEntityType();

// `deployed` is a READ, and it answers the only question that matters after a create:
// can the running app actually call this thing? It is handled before the spec file is
// touched because it takes an id, not a spec.
if (cmd === "deployed") {
  // An UNDEPLOYED entity answers 200 with an EMPTY BODY rather than 404, so `res.ok`
  // is the wrong question here — the same trap as the entity-type probe above.
  const r = await fetch(`${baseUrl}/api/entity/deployed/${entityType}/${file}`, { headers: H });
  const body = (await r.text()).trim();
  const live = r.ok && body.length > 0 && body.includes(`"id"`);
  console.log(
    live
      ? `${file}: DEPLOYED — the app can call it`
      : `${file}: NOT DEPLOYED — the app gets \`forbidden datasource: not found\`.\n` +
        `  Deploy the APPLICATION; that is what pulls its data sources in.`,
  );
  process.exit(live ? 0 : 1);
}

const spec = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
const entity = build(spec, entityType);

if (cmd === "plan") {
  console.log(`entityType resolved by probe: ${entityType}`);
  console.log(JSON.stringify(entity, null, 2));
  process.exit(0);
}
if (cmd !== "create") die(`unknown command "${cmd}"`);

const res = await fetch(`${baseUrl}/api/entity/create-update-or-delete/hierarchical`, {
  method: "POST", headers: H, body: JSON.stringify({ entity, requestType: "CREATED" }),
});
const text = await res.text();
if (!res.ok) die(`HTTP ${res.status}: ${text.slice(0, 500)}`);
const made = JSON.parse(text);
const obj = Array.isArray(made) ? made[0] : made;
console.log(`created data source "${obj.properties?.name}"`);
console.log(`  id          ${obj.id}`);
console.log(`  entityType  ${obj.entityType}   (resolved by probe, not hardcoded)`);
console.log(`  page        ${obj.properties?.interfacePageId}`);
console.log(`  calls       automation ${obj.properties?.inputs?.automationId}`);
console.log(`next: bind blocks to {{ ${obj.id}['data'] }} and re-read with get_data_sources`);

// The row exists, and that is NOT the same as the app being able to call it.
//
// A running app is an "application user", and that branch of
// WorkflowNodeExecutionClientImpl.validateRequest resolves the DEPLOYED data source.
// This script (and the builder) resolve the DRAFT, so a call from here succeeds while
// the browser gets `forbidden datasource: not found`. Reporting "created" and stopping
// is how that gap gets mistaken for a working binding — so say it out loud, every time.
console.log("");
console.log("NOT USABLE BY THE APP YET.");
console.log("  This created the DRAFT row. A deployed app resolves the DEPLOYED copy,");
console.log("  which does not exist until the APPLICATION is deployed - that deploy is");
console.log("  what pulls its data sources in. Until then the browser answers");
console.log("  `forbidden datasource: not found`, even though a call from a script works.");
console.log(`  check: node scripts/ua-datasource.mjs deployed ${obj.id}`);

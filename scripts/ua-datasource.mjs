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
// Writes to PRODUCTION only with an explicit `--env tool` on the command line.
//
// The entity-type PROBE below matters more, not less, across two environments:
// orbit has `e_data_source` where the devkit's tool assumes
// `e_data_source_deployed`, and there is no reason to assume prod answers the
// same way as orbit. It asks every time and says which it used.

import fs from "node:fs";
import path from "node:path";
import { APP_ID } from "./kit-config.mjs";
import { resolveEnv } from "./env.mjs";

const die = (m) => { console.error(`error: ${m}`); process.exit(1); };

const { env, baseUrl, headers: H, args: argv } = resolveEnv({ write: true });

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

const [cmd, file] = argv;
if (!cmd || !file) die("usage: ua-datasource.mjs plan|create <spec.json>");
const spec = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));

const { type: entityType } = await resolveEntityType();
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
console.log(`created data source "${obj.properties?.name}" on ${env}`);
console.log(`  id          ${obj.id}`);
console.log(`  entityType  ${obj.entityType}   (resolved by probe, not hardcoded)`);
console.log(`  page        ${obj.properties?.interfacePageId}`);
console.log(`  calls       automation ${obj.properties?.inputs?.automationId}`);
console.log(`next: bind blocks to {{ ${obj.id}['data'] }} and re-read with get_data_sources`);

#!/usr/bin/env node
// WRITE helper for object (entity type) schemas. This CHANGES the data model
// for everyone, so it does one narrow thing: add missing properties to an
// object's schema. It never removes or retypes anything.
//
//   node scripts/ua-schema.mjs add-fields <objectType> <name:type> [<name:type>...]
//   node scripts/ua-schema.mjs add-fields --all-archivable          (the trash fields)
//
// Mechanics, probed 2026-08-23:
//   GET  /api/entity-type?entityType=<id>   read
//   POST /api/entity-type/update            update - full definition, returns it back
//   POST /api/entity-type                   CREATE - errors with duplicate key if it exists
// A no-op round trip through /update is safe: schema and metadata come back
// byte-identical, only `version` moves.
//
// Refuses the tool (production) environment outright.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, ENTITY_TAGS } from "./kit-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const die = (m) => { console.error(`error: ${m}`); process.exit(1); };

const vars = {};
for (const line of fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m && !line.trim().startsWith("#")) vars[m[1]] = m[2];
}
const env = vars.UA_DEFAULT_ENV || "orbit";
if (env !== "orbit") die("refusing to change schemas anywhere but orbit");
const baseUrl = vars.UA_ORBIT_URL, cookie = vars.UA_ORBIT_COOKIE;
if (!baseUrl || !cookie) die("missing UA_ORBIT_URL or UA_ORBIT_COOKIE");

async function api(pathname, body) {
  const res = await fetch(baseUrl + pathname, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie: `_at=${cookie}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) die(`${pathname} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

const titleOf = (n) => n.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).trim();

// The two fields the deletion pipeline needs on everything archivable.
const TRASH_FIELDS = [
  ["archivedVia", "string"],  // "<type>:<id>" of the entity whose deletion caused this; empty = deleted directly
  ["archivedBy", "string"],   // id of the user who triggered it
];
// Which object types the trash/restore pipeline covers. Lives in
// kit.config.json (entities.archivable) so this script stays product-neutral.
const ARCHIVABLE = config.entities.archivable ?? [];

async function addFields(objectType, fields) {
  const def = await api(`/api/entity-type?entityType=${encodeURIComponent(objectType)}`);
  const props = def.schema?.schema?.properties;
  if (!props) die(`${objectType}: no schema.schema.properties - refusing to touch it`);

  const added = [];
  for (const [name, type] of fields) {
    if (name in props) continue;                       // idempotent: never retype an existing field
    props[name] = { type, title: titleOf(name), filterable: true };
    added.push(name);
  }
  if (added.length === 0) {
    console.log(`  ${objectType.padEnd(28)} already has them, unchanged`);
    return;
  }
  // keep the builder's field order sane
  if (def.input?.layout?.["ui:order"]) {
    for (const n of added) if (!def.input.layout["ui:order"].includes(n)) def.input.layout["ui:order"].push(n);
  }
  await api("/api/entity-type/update", def);

  const after = await api(`/api/entity-type?entityType=${encodeURIComponent(objectType)}`);
  const now = after.schema?.schema?.properties ?? {};
  const missing = added.filter((n) => !(n in now));
  if (missing.length) die(`${objectType}: wrote but ${missing.join(", ")} did not land`);
  console.log(`  ${objectType.padEnd(28)} added ${added.join(", ")}  (v${def.version} -> v${after.version})`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd !== "add-fields" || rest.length === 0) {
  die('usage: ua-schema.mjs add-fields <objectType> <name:type>... | add-fields --all-archivable');
}

if (rest[0] === "--all-archivable") {
  console.log(`adding ${TRASH_FIELDS.map((f) => f[0]).join(" + ")} to ${ARCHIVABLE.length} archivable objects:`);
  for (const t of ARCHIVABLE) await addFields(t, TRASH_FIELDS);
} else {
  const [objectType, ...specs] = rest;
  const fields = specs.map((s) => {
    const [n, t] = s.split(":");
    if (!n || !t) die(`bad field spec "${s}", want name:type`);
    return [n, t];
  });
  await addFields(objectType, fields);
}
console.log(`done - now re-snapshot with: node scripts/ua.mjs snap-types ${ENTITY_TAGS.map((x) => `--tag ${x}`).join(" ")}`);

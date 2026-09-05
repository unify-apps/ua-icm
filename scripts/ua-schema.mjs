#!/usr/bin/env node
// WRITE helper for object (entity type) schemas. This CHANGES the data model
// for everyone, so it does one narrow thing: add missing properties to an
// object's schema. It never removes or retypes anything.
//
//   node scripts/ua-schema.mjs add-fields <objectType> <name:type> [<name:type>...]
//
// <type> is string | number | integer | boolean | date | fk:<Type> | fk:USER.
// A fk: field is a real LOOKUP: it writes the property's foreignKey, the
// builder's LookupWidget and metadata.referenceKeys together, because a lookup
// missing any one of the three renders as a text box and stores a string that
// resolves to nothing.
//   node scripts/ua-schema.mjs add-fields --all-archivable          (the trash fields)
//
// Mechanics, probed 2026-08-23:
//   GET  /api/entity-type?entityType=<id>   read
//   POST /api/entity-type/update            update - full definition, returns it back
//   POST /api/entity-type                   CREATE - errors with duplicate key if it exists
// A no-op round trip through /update is safe: schema and metadata come back
// byte-identical, only `version` moves.
//
// Writes to PRODUCTION only with an explicit `--env tool` on the command line.

import { config, ENTITY_TAGS } from "./kit-config.mjs";
import { expandField } from "./field-types.mjs";
import { resolveEnv } from "./env.mjs";

const die = (m) => { console.error(`error: ${m}`); process.exit(1); };

const { env, baseUrl, cookie, args: argv } = resolveEnv({ write: true });

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
    const { prop, reference, lookup, isDate } = expandField(name, { type }, die);

    // Both halves of the definition must agree. `schema.schema` is what the
    // runtime reads; `input.schema` is what the BUILDER renders. Writing only
    // one gives a field that works in automations and is invisible on screen.
    props[name] = prop;
    if (def.input?.schema?.properties) def.input.schema.properties[name] = prop;

    // A lookup is three things in agreement, not one. Without the layout entry
    // the builder draws a free-text box that stores an unresolvable string.
    if (lookup && def.input?.layout) def.input.layout[name] = lookup;
    if (reference) {
      def.metadata.referenceKeys ??= [];
      if (!def.metadata.referenceKeys.some((r) => r.key === `properties.${name}`))
        def.metadata.referenceKeys.push({ key: `properties.${name}`, referenceType: reference });
    }
    if (isDate) {
      def.metadata.dateFields ??= [];
      if (!def.metadata.dateFields.includes(name)) def.metadata.dateFields.push(name);
    }
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

  // Re-READ rather than trust the update's response: a write that reports
  // success and did not land is the failure mode this whole kit is built around.
  const after = await api(`/api/entity-type?entityType=${encodeURIComponent(objectType)}`);
  const now = after.schema?.schema?.properties ?? {};
  const missing = added.filter((n) => !(n in now));
  if (missing.length) die(`${objectType}: wrote but ${missing.join(", ")} did not land`);
  for (const n of added) {
    const fk = now[n]?.foreignKey?.reference;
    console.log(`    ${n}${fk ? `  -> lookup to ${fk}` : ""}`);
  }
  console.log(`  ${objectType.padEnd(28)} added ${added.join(", ")}  (v${def.version} -> v${after.version})`);
}

const [cmd, ...rest] = argv;
if (cmd !== "add-fields" || rest.length === 0) {
  die('usage: ua-schema.mjs add-fields <objectType> <name:type>... | add-fields --all-archivable\n  types: string|number|integer|boolean|date|fk:<Type>|fk:USER');
}

if (rest[0] === "--all-archivable") {
  console.log(`adding ${TRASH_FIELDS.map((f) => f[0]).join(" + ")} to ${ARCHIVABLE.length} archivable objects:`);
  for (const t of ARCHIVABLE) await addFields(t, TRASH_FIELDS);
} else {
  const [objectType, ...specs] = rest;
  const fields = specs.map((s) => {
    const i = s.indexOf(":");
    const n = s.slice(0, i), t = s.slice(i + 1);   // "currencyId:fk:Currency" -> ["currencyId", "fk:Currency"]
    if (!n || !t) die(`bad field spec "${s}", want name:type`);
    return [n, t];
  });
  await addFields(objectType, fields);
}
console.log(`done - now re-snapshot with: node scripts/ua.mjs snap-types ${ENTITY_TAGS.map((x) => `--tag ${x}`).join(" ")}`);

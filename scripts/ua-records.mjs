#!/usr/bin/env node
// SEED real records into the product's objects.
//
//   node scripts/ua-records.mjs plan   <set.json> [--env orbit|tool]
//   node scripts/ua-records.mjs seed   <set.json> [--env orbit|tool]
//   node scripts/ua-records.mjs status <set.json> [--env orbit|tool]
//
// WHY THIS EXISTS AND WHY IT IS NOT fixtures.mjs.
//
// `fixtures.mjs` writes TEST data: loudly-prefixed KITFIX- families that its
// `reset` deletes by prefix match, and it is orbit-only forever for exactly
// that reason. This writes the REAL records a product needs to exist at all -
// the currencies, the fiscal calendar, the org - and those are not test data
// and must never be deleted by a prefix sweep.
//
// So the two are deliberately different tools with different powers:
//
//   fixtures.mjs   seeds AND deletes   orbit only        test data
//   ua-records.mjs seeds only          --env tool ok     real data
//
// THIS SCRIPT CAN NEVER DELETE OR UPDATE ANYTHING. There is no reset, no
// --force and no upsert. A row whose business key already exists is reported
// and skipped, so re-running is safe and a half-finished seed is resumable.
// Correcting a record that is already wrong is a deliberate act through the
// builder or an automation, not a rerun of this.
//
// The file format is the fixture format on purpose - anyone who can read a
// fixture family can read one of these:
//
//   {
//     "set": "phase-1-org",
//     "keyField": { "Currency": "code", "Payee": "employeeId" },
//     "records": {
//       "Currency": [ { "$ref": "USD", "code": "USD", ... } ],
//       "Payee":    [ { "employeeId": "E-1", "currencyId": "@USD", ... } ]
//     }
//   }
//
// `$ref` names a row so later rows can point at the platform id it was given,
// with "@<ref>". Object order in `records` is insertion order, so parents must
// come before the children that reference them. A bare YYYY-MM-DD in a date
// field means midnight UTC, the same rule the automations use.
//
// Writes to PRODUCTION only with an explicit `--env tool` on the command line.

import fs from "node:fs";
import path from "node:path";
import { resolveEnv, ROOT } from "./env.mjs";

const die = (m) => { console.error(`error: ${m}`); process.exit(1); };

const { env, baseUrl, headers: H, args: argv } = resolveEnv({ write: true });

async function api(pathname, body) {
  const res = await fetch(baseUrl + pathname, { method: "POST", headers: H, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) die(`${pathname} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

// Dates are stored as epoch millis. A bare YYYY-MM-DD means midnight UTC on
// that day - anything else here would make the seed disagree with the
// automations that read it.
const DATE_FIELDS = new Set([
  "effectiveStart", "effectiveEnd", "hireDate", "terminationDate", "startDate", "endDate",
]);
const toEpoch = (v) =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(v + "T00:00:00Z") : v;

const [cmd, file] = argv;
if (!cmd || !file) die("usage: ua-records.mjs plan|seed|status <set.json> [--env orbit|tool]");
const setPath = path.resolve(file);
if (!fs.existsSync(setPath)) die(`no record set at ${path.relative(ROOT, setPath)}`);
const set = JSON.parse(fs.readFileSync(setPath, "utf8"));
if (!set.records) die("set needs a `records` object");
if (!set.keyField) die("set needs a `keyField` map - one business key per object type");

const types = Object.keys(set.records);
for (const t of types) if (!set.keyField[t]) die(`no keyField for "${t}" - every type needs its business key`);

/** Read a type's existing rows once, so the whole seed costs one call per type. */
async function existingByKey(type) {
  const key = set.keyField[type];
  const r = await api(`/api/entity/${type}`, { page: { limit: 500, offset: 0 } });
  const rows = r.response?.objects ?? r.objects ?? [];
  const byKey = new Map();
  for (const o of rows) {
    const k = o.properties?.[key];
    if (k !== undefined) byKey.set(String(k), o);
  }
  return byKey;
}

if (cmd === "plan") {
  console.log(`set     ${set.set}`);
  console.log(`target  ${env}  ${baseUrl}`);
  let total = 0;
  for (const t of types) {
    console.log(`  ${t.padEnd(24)} ${String(set.records[t].length).padStart(3)} row(s)   key=${set.keyField[t]}`);
    total += set.records[t].length;
  }
  console.log(`${total} record(s) would be created, in that order. Nothing was called.`);
  process.exit(0);
}

if (cmd === "status") {
  let present = 0, missing = 0;
  for (const t of types) {
    const have = await existingByKey(t);
    const want = set.records[t].map((r) => String(r[set.keyField[t]]));
    const here = want.filter((k) => have.has(k)).length;
    present += here;
    missing += want.length - here;
    console.log(`  ${t.padEnd(24)} ${String(here).padStart(3)}/${String(want.length).padEnd(3)} present`);
  }
  console.log(`${present} present, ${missing} missing on ${env}`);
  process.exit(0);
}

if (cmd !== "seed") die(`unknown command "${cmd}"`);

const refs = {};
let created = 0, skipped = 0;
for (const type of types) {
  const key = set.keyField[type];
  const have = await existingByKey(type);
  for (const row of set.records[type]) {
    const { $ref, ...props } = row;
    const k = String(props[key]);

    const already = have.get(k);
    if (already) {
      if ($ref) refs[$ref] = already.id;
      console.log(`  = ${type} ${k} (exists, left alone)`);
      skipped++;
      continue;
    }

    const out = {};
    for (const [f, v] of Object.entries(props)) {
      if (typeof v === "string" && v.startsWith("@")) {
        const id = refs[v.slice(1)];
        if (!id) die(`${type} ${k}: unresolved reference ${v} - define it earlier in the set`);
        out[f] = id;
      } else {
        out[f] = DATE_FIELDS.has(f) ? toEpoch(v) : v;
      }
    }

    const res = await api("/api/entity/create-update-or-delete/hierarchical",
                          { entity: { entityType: type, properties: out }, requestType: "CREATED" });
    const made = Array.isArray(res) ? res[0] : res;
    if ($ref) refs[$ref] = made.id;
    created++;
    console.log(`  + ${type} ${k}  -> ${made.id}`);
  }
}
console.log(`\n${created} created, ${skipped} already there, on ${env}. Nothing was updated or deleted.`);

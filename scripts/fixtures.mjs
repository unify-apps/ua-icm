#!/usr/bin/env node
// Fixture families for the regression suites.
//
//   node scripts/fixtures.mjs status <family>        what exists right now
//   node scripts/fixtures.mjs seed   <family>        create what is missing
//   node scripts/fixtures.mjs reset  <family> --yes  delete the family, then seed
//
// A family is a JSON file in tests/fixtures/. Every record's business key
// starts with a loud prefix (KITFIX-) so it can never be mistaken for - or
// matched by a filter aimed at - real data.
//
// ICM SAFETY RULE: fixtures are participants, seats and periods of our own
// invention. A suite that touched real pay data is the one mistake in this repo
// that reaches somebody's bank account, so `reset` only ever deletes records
// whose prefixField value starts with the family's prefix, and it refuses to
// run without --yes.
//
// ORBIT ONLY, DELIBERATELY, and the ONE script left that way.
//
// Every other write script became `--env`-aware on 2026-09-05 when the product
// moved to tool prod. This one did not, and the asymmetry is the point: seeding
// is harmless but `reset` DELETES, and its safety rests entirely on a prefix
// match. A typo'd prefixField, a family file edited in a hurry, or a fixture
// family that grows to cover an object real records also live in, and the blast
// radius on prod is somebody's pay history.
//
// Test data belongs on UAT. If you ever genuinely need a fixture family on prod,
// that is a decision to take deliberately with the product team and write down —
// not a flag to add here.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const die = (m) => { console.error(`error: ${m}`); process.exit(1); };

const vars = {};
for (const line of fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m && !line.trim().startsWith("#")) vars[m[1]] = m[2];
}
const env = vars.UA_DEFAULT_ENV || "orbit";
if (env !== "orbit") {
  die("refusing to write fixtures anywhere but orbit - `reset` deletes by prefix match, " +
      "and test data does not belong on production. See the header.");
}
const baseUrl = vars.UA_ORBIT_URL, cookie = vars.UA_ORBIT_COOKIE;
if (!baseUrl || !cookie) die("missing UA_ORBIT_URL or UA_ORBIT_COOKIE");

const H = { cookie: `_at=${cookie}`, "content-type": "application/json" };
async function api(pathname, body) {
  const res = await fetch(baseUrl + pathname, { method: "POST", headers: H, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) die(`${pathname} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

// A bare YYYY-MM-DD in a fixture means midnight UTC on that day - the same rule
// the automations use. Anything else here would make the fixtures disagree with
// the thing they are testing.
const toEpoch = (v) =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(v + "T00:00:00Z") : v;
const DATE_FIELDS = new Set(["effectiveStart", "effectiveEnd", "hireDate", "terminationDate", "startDate", "endDate"]);

const [cmd, familyName, ...flags] = process.argv.slice(2);
if (!cmd || !familyName) die("usage: fixtures.mjs status|seed|reset <family> [--yes]");
const file = path.join(ROOT, "tests", "fixtures", `${familyName}.json`);
if (!fs.existsSync(file)) die(`no fixture family at ${path.relative(ROOT, file)}`);
const fam = JSON.parse(fs.readFileSync(file, "utf8"));
const PREFIX = fam.family.split("-")[0] + "-";   // "KITFIX-SEATS" -> "KITFIX-"

async function listExisting(type) {
  const key = fam.prefixField[type];
  const r = await api(`/api/entity/${type}`, { page: { limit: 500, offset: 0 } });
  const rows = r.response?.objects ?? r.objects ?? [];
  return rows.filter((o) => String(o.properties?.[key] ?? "").startsWith(PREFIX));
}

async function status() {
  let total = 0;
  for (const type of Object.keys(fam.records)) {
    const rows = await listExisting(type);
    total += rows.length;
    console.log(`  ${type.padEnd(26)} ${String(rows.length).padStart(3)} record(s) with ${fam.prefixField[type]} starting "${PREFIX}"`);
  }
  console.log(`${total} fixture record(s) in family ${fam.family}`);
  return total;
}

async function destroy() {
  let n = 0;
  // children first - a dangling FK in a fixture is noise in the next run's diff
  for (const type of Object.keys(fam.records).reverse()) {
    for (const row of await listExisting(type)) {
      await api("/api/entity/create-update-or-delete/hierarchical",
                { entity: { entityType: type, id: row.id }, requestType: "DELETED" });
      n++;
    }
    console.log(`  deleted ${type}`);
  }
  console.log(`${n} fixture record(s) deleted`);
}

async function seed() {
  const refs = {};
  let n = 0;
  for (const [type, rows] of Object.entries(fam.records)) {
    const existing = await listExisting(type);
    const key = fam.prefixField[type];
    for (const row of rows) {
      const { $ref, ...props } = row;
      const already = existing.find((e) => e.properties?.[key] === props[key]);
      if (already) {
        if ($ref) refs[$ref] = already.id;
        console.log(`  = ${type} ${props[key]} (exists)`);
        continue;
      }
      const out = {};
      for (const [k, v] of Object.entries(props)) {
        // "@REF" resolves to the platform id minted for that $ref earlier in the file
        if (typeof v === "string" && v.startsWith("@")) {
          const id = refs[v.slice(1)];
          if (!id) die(`${type} ${props[key]}: unresolved reference ${v} - define it earlier in the family`);
          out[k] = id;
        } else out[k] = DATE_FIELDS.has(k) ? toEpoch(v) : v;
      }
      const res = await api("/api/entity/create-update-or-delete/hierarchical",
                            { entity: { entityType: type, properties: out }, requestType: "CREATED" });
      const created = Array.isArray(res) ? res[0] : res;
      if ($ref) refs[$ref] = created.id;
      n++;
      console.log(`  + ${type} ${props[key]}  -> ${created.id}`);
    }
  }
  console.log(`${n} fixture record(s) created`);
}

if (cmd === "status") { await status(); }
else if (cmd === "seed") { await seed(); }
else if (cmd === "reset") {
  if (!flags.includes("--yes")) {
    console.log(`reset would DELETE and recreate every record below. Re-run with --yes to do it.\n`);
    await status();
    process.exit(1);
  }
  await destroy();
  await seed();
} else die(`unknown command "${cmd}"`);

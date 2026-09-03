#!/usr/bin/env node
// Does the onboarding doc still describe the repo that exists?
//
//   node scripts/check-docs.mjs            report gaps, exit 1 if any
//   node scripts/check-docs.mjs --warn     report gaps, always exit 0
//
// A new script or a new docs/ folder that nobody wrote down is invisible to the
// next person. This cannot write the prose for you - it can only refuse to let
// the gap stay quiet. Fix a finding by DESCRIBING the thing in
// docs/START-HERE.html (what it is and when you would reach for it), not by
// adding its name somewhere to silence the check.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const P = (...a) => path.join(ROOT, ...a);
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");

const START = P("docs", "START-HERE.html");
const README = P("README.md");
const CLAUDE = P("CLAUDE.md");

// START-HERE is the onboarding page; README is setup; CLAUDE.md is procedure.
// A thing counts as documented if the onboarding page or the README names it.
const onboarding = read(START) + read(README);
const procedure = read(CLAUDE);

const findings = [];

// ---- every script must be described somewhere a newcomer reads
const scripts = fs
  .readdirSync(P("scripts"))
  .filter((f) => f.endsWith(".mjs") && f !== "kit-config.mjs")
  .sort();
for (const s of scripts) {
  if (onboarding.includes(s)) continue;
  findings.push({
    what: `scripts/${s}`,
    say: `not named in docs/START-HERE.html or README.md — a newcomer cannot discover it`,
  });
}

// ---- every docs/ area must be described
const docDirs = fs
  .readdirSync(P("docs"), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
for (const d of docDirs) {
  if (onboarding.includes(`docs/${d}`)) continue;
  findings.push({ what: `docs/${d}/`, say: `not described in the onboarding page` });
}

// ---- top-level folders that are part of the working model
for (const d of ["scripts", "snapshots", "tests", "notes", "docs"]) {
  if (!fs.existsSync(P(d))) continue;
  if (onboarding.includes(`${d}/`)) continue;
  findings.push({ what: `${d}/`, say: `not described in the onboarding page` });
}

// ---- a script that writes to the platform must be declared as such in CLAUDE.md,
//      because that list is the safety contract, not a convenience.
for (const s of scripts) {
  const body = read(P("scripts", s));
  const writes = /method:\s*["']POST["']|\bPOST\b.*\/api\//.test(body);
  const readonly = /read-only|Read-only|cannot change|never changes/.test(body.slice(0, 1200));
  if (writes && !readonly && !procedure.includes(s)) {
    findings.push({
      what: `scripts/${s}`,
      say: `POSTs to the platform but is not listed in CLAUDE.md — the script list there is the safety contract`,
    });
  }
}

const warnOnly = process.argv.includes("--warn");

if (!findings.length) {
  console.log("docs describe the repo that exists");
  process.exit(0);
}

console.log(`${findings.length} thing(s) exist but are not written down:\n`);
for (const f of findings) console.log(`  ${f.what.padEnd(28)} ${f.say}`);
console.log(
  `\nFix by describing each in docs/START-HERE.html (and CLAUDE.md for anything that writes).\n` +
    `Naming it to silence this check, without saying what it is for, is worse than the gap.`,
);
process.exit(warnOnly ? 0 : 1);

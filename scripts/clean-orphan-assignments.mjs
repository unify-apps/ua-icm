// Delete PlanAssignment rows whose parent Plan no longer exists.
//
//   node scripts/clean-orphan-assignments.mjs          dry run, lists what it would delete
//   node scripts/clean-orphan-assignments.mjs --yes    deletes them
//
// A PlanAssignment row is only reachable through its plan, so once the plan is gone the
// row is invisible to the product and still counts in every audit. Suite runs whose
// cleanup did not cover their assignment rows are how they accumulate - see the Get
// Plan suite's "clean up the resolving plan's assignment rows" case for the fix that
// stops it at the source. This cleans up what already leaked.
//
// Re-derives the orphan set LIVE every run rather than trusting a saved id list: many
// suites have run since one was captured, so a stale list could name a row that has
// since become legitimate, or miss one that has since been orphaned.
//
// A row is deleted only when its planId matches NEITHER a live plan's record id nor a
// live plan's business key. Anything else is left alone, loudly.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8");
const g = (k) => { const m = new RegExp("^\\s*" + k + "\\s*=\\s*\"?([^\"\\n]*)\"?", "m").exec(env); return m && m[1].trim(); };
const B = g("UA_TOOL_URL");
const H = { cookie: "_at=" + g("UA_TOOL_COOKIE"), "content-type": "application/json" };
const YES = process.argv.includes("--yes");

const list = async (t) => {
  const r = await fetch(`${B}/api/entity/${t}`, { method: "POST", headers: H, body: JSON.stringify({ page: { limit: 500, offset: 0 } }) });
  const j = JSON.parse(await r.text());
  return j.objects ?? j.response?.objects ?? [];
};

(async () => {
  const plans = await list("Plan");
  const asg = await list("PlanAssignment");
  if (plans.length === 0) {
    console.error("refusing: zero Plan records read back, which is more likely a bad read than an empty object");
    process.exit(1);
  }
  const liveRec = new Set(plans.map((p) => p.id));
  const livePid = new Set(plans.map((p) => p.properties?.planId).filter(Boolean));

  const orphan = [], kept = [];
  for (const a of asg) {
    const pid = a.properties?.planId;
    (pid && !liveRec.has(pid) && !livePid.has(pid) ? orphan : kept).push(a);
  }
  console.log(`${plans.length} live plan(s), ${asg.length} assignment row(s)`);
  console.log(`${kept.length} row(s) have a living parent and will NOT be touched`);
  console.log(`${orphan.length} row(s) are orphaned:\n`);
  for (const o of orphan) console.log(`   ${o.id}  ${o.properties?.name ?? "(unnamed)"}`);

  if (orphan.length === 0) { console.log("\nnothing to delete"); return; }
  if (!YES) { console.log(`\ndry run - re-run with --yes to delete these ${orphan.length}`); return; }

  let n = 0;
  for (const o of orphan) {
    const r = await fetch(`${B}/api/entity/create-update-or-delete/hierarchical`, {
      method: "POST", headers: H,
      body: JSON.stringify({ entity: { entityType: "PlanAssignment", id: o.id }, requestType: "DELETED" }),
    });
    if (!r.ok) { console.error(`   FAILED ${o.id}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`); continue; }
    n++;
  }
  console.log(`\ndeleted ${n} of ${orphan.length}`);

  // Assert the READ, never the write's status code.
  const after = await list("PlanAssignment");
  const stillThere = after.filter((a) => orphan.some((o) => o.id === a.id));
  console.log(stillThere.length === 0
    ? `read back: ${after.length} row(s) remain, none of them orphans`
    : `!! ${stillThere.length} orphan(s) SURVIVED the delete: ${stillThere.map((s) => s.id).join(", ")}`);
})();

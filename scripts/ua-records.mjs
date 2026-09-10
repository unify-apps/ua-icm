// Read-only record reader. Ad-hoc `POST /api/entity/{type}` search, platform filter
// dialect (`op`/`field`/`values`), with the `properties.` prefix the endpoint wants.
//
// Read-only on purpose: this kit already has one writer (fixtures.mjs) and adding a
// second write path is how two conventions start disagreeing about what landed.
//
//   node scripts/ua-records.mjs <Type> [--limit N] [--offset N] [--where field=value] [--fields a,b,c]
//
// The endpoint IGNORES includeTotalCount, so `total` is never returned here - use a
// storage fetch node inside an automation when a count is what you need.
import { resolveEnv } from "./env.mjs";

const { baseUrl, headers, args } = resolveEnv();
const type = args[0];
if (!type) {
  console.error("usage: node scripts/ua-records.mjs <Type> [--limit N] [--offset N] [--where f=v] [--fields a,b]");
  process.exit(1);
}
const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
const limit = Number(flag("--limit", 200));
const offset = Number(flag("--offset", 0));
const fields = flag("--fields", "");

const values = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] !== "--where") continue;
  const [f, ...rest] = String(args[i + 1]).split("=");
  values.push({ field: f.startsWith("properties.") || f === "id" ? f : `properties.${f}`, op: "EQUAL", values: [rest.join("=")] });
}

const body = { page: { limit, offset } };
if (values.length) body.filter = { op: "AND", values };

const res = await fetch(`${baseUrl}/api/entity/${type}`, { method: "POST", headers, body: JSON.stringify(body) });
const json = await res.json().catch(() => ({}));
if (!res.ok) { console.error(`HTTP ${res.status}`, JSON.stringify(json).slice(0, 600)); process.exit(1); }
const rows = json.response?.objects ?? json.objects ?? [];
const want = fields ? fields.split(",").map((s) => s.trim()) : null;
console.log(`${rows.length} ${type} row(s)`);
for (const r of rows) {
  const p = r.properties ?? {};
  const shown = want ? Object.fromEntries(want.map((k) => [k, k === "id" ? r.id : p[k]])) : { id: r.id, ...p };
  console.log(JSON.stringify(shown));
}

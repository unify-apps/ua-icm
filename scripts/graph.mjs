#!/usr/bin/env node
// Builds the dependency graph of every ICM asset and renders it.
//
//   node scripts/graph.mjs                 write docs/architecture.html
//   node scripts/graph.mjs --check         exit 1 if it is stale (for the gate)
//   node scripts/graph.mjs --json <path>   also dump the raw graph, for querying
//
// NOTHING here is hand-maintained. The graph is DERIVED from what the repo
// already records, so it cannot drift from reality the way a hand-drawn diagram
// does:
//
//   snapshots/orbit/entity-types/  -> objects, their fields, their FK edges
//   snapshots/orbit/automations/   -> automations, what they read, what they
//                                     call, and their real deploymentState
//   docs/automations/*.md          -> which automations have a written spec
//   docs/pages/*.md                -> pages, and the callables they invoke
//                                     (the ONLY record of that dependency)
//   tests/<id>.json                -> which automations have a suite
//   docs/model/00-domain-model.md  -> objects that are proposed but not built
//
// If an asset is missing from the picture, the fix is to record it in one of
// those places, never to edit the output.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENTITY_TAGS } from "./kit-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const P = (...a) => path.join(ROOT, ...a);
const read = (f) => fs.readFileSync(f, "utf8");
const readJson = (f) => JSON.parse(read(f));
const listJson = (dir) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];

const nodes = [];
const edges = [];
const addEdge = (from, to, kind, label) => {
  if (!from || !to || from === to) {
    if (from === to && from) edges.push({ from, to, kind, label, self: true });
    return;
  }
  edges.push({ from, to, kind, label });
};

// ---------------------------------------------------------------- objects
const ETYPES = P("snapshots", "orbit", "entity-types");
const builtObjects = new Set();

for (const f of listJson(ETYPES)) {
  const d = readJson(path.join(ETYPES, f));
  const id = `obj:${d.id}`;
  const props = d.schema?.schema?.properties ?? {};
  const unique = d.metadata?.uniqueKeyFields ?? [];
  builtObjects.add(d.id);

  nodes.push({
    id,
    kind: "object",
    label: d.id,
    status: "live",
    meta: {
      fields: Object.keys(props).length,
      unique,
      tags: d.tags ?? [],
      fieldNames: Object.keys(props),
    },
  });

  for (const [name, prop] of Object.entries(props)) {
    const ref = prop.foreignKey?.reference;
    if (!ref) continue;
    if (ref === "USER") continue; // platform user, not one of ours
    const target = ref.replace(/^ENTITY_ID:/, "");
    addEdge(id, `obj:${target}`, "fk", name);
  }
}

// Objects the model proposes but nobody has built. Parsed from the domain
// model's tables: rows that begin with a single-backticked name.
const MODEL = P("docs", "model", "00-domain-model.md");
if (fs.existsSync(MODEL)) {
  const seen = new Set();
  for (const line of read(MODEL).split("\n")) {
    const m = line.match(/^\|\s*`([A-Z][A-Za-z0-9]*)`\s*(?:⌛\s*)?\|/);
    if (!m) continue;
    const name = m[1];
    if (builtObjects.has(name) || seen.has(name)) continue;
    seen.add(name);
    nodes.push({ id: `obj:${name}`, kind: "object", label: name, status: "planned", meta: {} });
  }
}

// ------------------------------------------------------------ automations
const AUTOS = P("snapshots", "orbit", "automations");
const specFor = new Map(); // workflowId -> spec file
const SPECS = P("docs", "automations");
if (fs.existsSync(SPECS)) {
  for (const f of fs.readdirSync(SPECS).filter((x) => x.endsWith(".md"))) {
    if (f.startsWith("00-") || f.startsWith("_")) continue;
    const body = read(path.join(SPECS, f));
    for (const id of body.match(/\b[0-9a-f]{24}\b/g) ?? []) specFor.set(id, `docs/automations/${f}`);
  }
}

for (const f of listJson(AUTOS)) {
  const d = readJson(path.join(AUTOS, f));
  const id = `auto:${d.id}`;
  const ds = d.deploymentState ?? {};
  const deployed = ds.status === "DEPLOYED" && ds.workflowVersion === d.version;
  const hasSuite = fs.existsSync(P("tests", `${d.id}.json`));
  const hasSpec = specFor.has(d.id);

  // draft = exists and runs; ready = spec + suite, deployable; live = deployed
  const status = deployed ? "live" : hasSpec && hasSuite ? "ready" : "draft";

  const start = (d.nodes ?? []).find((n) => n.type === "START");
  const callable = start?.context?.resourceName === "callables_from_automation";
  const statuses = new Set();
  for (const n of d.nodes ?? []) {
    const s = n.inputs?.result?.status;
    if (typeof s === "string" && s) statuses.add(s);
  }

  nodes.push({
    id,
    kind: "automation",
    label: d.name ?? d.id,
    status,
    meta: {
      workflowId: d.id,
      version: d.version,
      nodes: (d.nodes ?? []).length,
      callable,
      spec: specFor.get(d.id) ?? null,
      suite: hasSuite ? `tests/${d.id}.json` : null,
      deployed,
      statuses: [...statuses],
      inputs: Object.keys(start?.inputs?.setup?.properties ?? {}),
      outputs: Object.keys(start?.inputs?.result?.properties ?? {}),
    },
  });

  for (const n of d.nodes ?? []) {
    const rn = n.context?.resourceName ?? "";
    const ot = n.inputs?.object_type;
    if (ot) {
      const writes = /create|update|delete|upsert/.test(rn);
      addEdge(id, `obj:${ot}`, writes ? "writes" : "reads");
    }
    if (rn.includes("call_automation")) {
      const target = n.inputs?.automationId ?? n.inputs?.workflowId;
      if (typeof target === "string" && /^[0-9a-f]{24}$/.test(target)) addEdge(id, `auto:${target}`, "calls");
    }
  }
}

// ------------------------------------------------------------------ pages
const PAGES = P("docs", "pages");
if (fs.existsSync(PAGES)) {
  for (const f of fs.readdirSync(PAGES).filter((x) => x.endsWith(".md"))) {
    if (f.startsWith("00-") || f.startsWith("_")) continue;
    const body = read(path.join(PAGES, f));
    const title = body.match(/^#\s*(?:Page\s*\|\s*)?(.+)$/m)?.[1]?.trim() ?? f;
    // Read the WHOLE "Built state" line, not just what follows the colon.
    // The old test only matched "not built" immediately after the colon, so a
    // spec saying "**Built state**: **specified, not built.**" counted as BUILT
    // and the page showed as live on the map - a false green, which is the one
    // failure this picture exists to prevent (found 2026-09-03).
    const stateLine = body.match(/^\s*\*\*Built state\b.*$/im)?.[0] ?? "";
    const built = stateLine !== "" && !/\bnot (yet )?built\b/i.test(stateLine);
    const id = `page:${f.replace(/\.md$/, "")}`;
    nodes.push({
      id,
      kind: "page",
      label: title,
      status: built ? "live" : "planned",
      meta: { spec: `docs/pages/${f}`, built },
    });
    // the callables section is the only record of this dependency
    const sec = body.split(/##\s*Callables it invokes/i)[1]?.split(/\n##\s/)[0] ?? "";
    for (const wid of new Set(sec.match(/\b[0-9a-f]{24}\b/g) ?? [])) addEdge(id, `auto:${wid}`, "calls");
  }
}

// ------------------------------------------------------------------ prune
// Edges pointing at something we have no node for (a retired object, an
// automation not yet snapshotted) become ghost nodes rather than vanishing —
// a dangling reference is exactly what this graph exists to make visible.
const known = new Set(nodes.map((n) => n.id));
for (const e of edges) {
  for (const side of [e.from, e.to]) {
    if (known.has(side)) continue;
    known.add(side);
    nodes.push({
      id: side,
      kind: side.split(":")[0].replace("obj", "object").replace("auto", "automation"),
      label: side.split(":").slice(1).join(":"),
      status: "missing",
      meta: {},
    });
  }
}

// --------------------------------------------------------------- progress
const counts = {};
for (const n of nodes) {
  counts[n.kind] ??= { live: 0, ready: 0, draft: 0, planned: 0, missing: 0, total: 0 };
  counts[n.kind][n.status]++;
  counts[n.kind].total++;
}

const graph = {
  generated: new Date().toISOString(),
  generator: "scripts/graph.mjs",
  tags: ENTITY_TAGS,
  counts,
  nodes: nodes.sort((a, b) => a.id.localeCompare(b.id)),
  edges,
};

// ----------------------------------------------------------------- output
// ONE file. The data lives inside it (the page embeds the graph as JSON), and
// the rules that outlive any one asset live in CLAUDE.md. A separate .json and
// .md describing the same thing is three places for one truth to rot in.
//   --json <path>   also write the raw graph, for ad-hoc querying
const htmlPath = P("docs", "architecture.html");
const html = render(graph);

const jsonFlag = process.argv.indexOf("--json");
if (jsonFlag !== -1 && process.argv[jsonFlag + 1]) {
  fs.writeFileSync(process.argv[jsonFlag + 1], JSON.stringify(graph, null, 2) + "\n");
  console.log(`wrote ${process.argv[jsonFlag + 1]}`);
}

if (process.argv.includes("--check")) {
  const strip = (x) => x.replace(/"generated":\s*"[^"]*"/, "").replace(/generated [^<]*</, "<");
  if (!fs.existsSync(htmlPath) || strip(read(htmlPath)) !== strip(html)) {
    console.error(`docs/architecture.html is stale.\n\nRun: node scripts/graph.mjs`);
    process.exit(1);
  }
  console.log("architecture graph is current");
  process.exit(0);
}

fs.writeFileSync(htmlPath, html);
const line = (k) => {
  const c = counts[k];
  if (!c) return `${k}: none`;
  return `${k}: ${c.total} (${c.live} live, ${c.ready} ready, ${c.draft} draft, ${c.planned} planned${c.missing ? `, ${c.missing} MISSING` : ""})`;
};
console.log(`wrote docs/architecture.html`);
for (const k of ["page", "automation", "object"]) console.log(`  ${line(k)}`);
if (Object.values(counts).some((c) => c.missing)) {
  console.log(`\n  NOTE: a "missing" node is referenced but not snapshotted - investigate before trusting the picture.`);
}

// ===================================================================== view
function render(g) {
  const data = JSON.stringify(g).replace(/</g, "\\u003c");
  return `<!-- GENERATED by scripts/graph.mjs - do not hand-edit. Re-run the generator. -->
<!-- charset FIRST: this file is full of em dashes and middots, and without a
     declared encoding a browser falls back to Latin-1 and renders them as
     "â€"" and "Â·". Opened from disk there is no server header to save it. -->
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ICM Architecture Map</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
  :root{
    --paper:#EDEFF3;--surface:#FFFFFF;--sunk:#F2F4F7;--ink:#161D26;--ink-soft:#46545F;
    --muted:#7A8794;--line:#D3DAE2;--edge:#B9C3CE;--chrome:#F7F8FA;
    --page:#6B4E9E;--page-bg:#EFEAF8;
    --automation:#1D5C9E;--automation-bg:#E7F0F9;
    --object:#0E6B61;--object-bg:#E1F0ED;
    --live:#0E6B61;--ready:#1D5C9E;--draft:#8C6209;--planned:#93A0AD;--missing:#A6392F;
  }
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
    --paper:#0B1117;--surface:#161E27;--sunk:#1B242E;--ink:#EAF0F6;--ink-soft:#AFBECB;
    --muted:#7F8F9E;--line:#2A3541;--edge:#3A4754;--chrome:#131B23;
    --page:#C2A6E0;--page-bg:#241B33;
    --automation:#82B4E6;--automation-bg:#132539;
    --object:#5DC6B7;--object-bg:#0E2E2B;
    --live:#5DC6B7;--ready:#82B4E6;--draft:#DDB257;--planned:#5A6875;--missing:#E68C82;
  }}
  :root[data-theme="dark"]{
    --paper:#0B1117;--surface:#161E27;--sunk:#1B242E;--ink:#EAF0F6;--ink-soft:#AFBECB;
    --muted:#7F8F9E;--line:#2A3541;--edge:#3A4754;--chrome:#131B23;
    --page:#C2A6E0;--page-bg:#241B33;
    --automation:#82B4E6;--automation-bg:#132539;
    --object:#5DC6B7;--object-bg:#0E2E2B;
    --live:#5DC6B7;--ready:#82B4E6;--draft:#DDB257;--planned:#5A6875;--missing:#E68C82;
  }
  *{box-sizing:border-box}
  body{background:var(--paper);color:var(--ink);font-family:"IBM Plex Sans",ui-sans-serif,system-ui,sans-serif;line-height:1.5}
  .shell{max-width:1320px;margin:0 auto;padding:22px 18px 40px;display:flex;flex-direction:column;gap:14px}

  /* window chrome */
  .win{border:1.5px solid var(--line);border-radius:13px;overflow:hidden;background:var(--surface);
       box-shadow:0 1px 2px rgba(20,28,36,.05),0 18px 48px -26px rgba(20,28,36,.4)}
  .bar{background:var(--chrome);border-bottom:1.5px solid var(--line);padding:9px 14px;
       display:flex;align-items:center;gap:12px}
  .dots{display:flex;gap:6px}.dots i{width:10px;height:10px;border-radius:50%;background:var(--line);display:block}
  .bar .name{font-family:"IBM Plex Mono",monospace;font-size:12.5px;color:var(--muted);letter-spacing:.02em}
  .bar .right{margin-left:auto;display:flex;gap:6px;align-items:center}
  .btn{font-family:"IBM Plex Mono",monospace;font-size:11px;padding:4px 10px;border-radius:6px;
       border:1.5px solid var(--line);background:var(--surface);color:var(--ink-soft);cursor:pointer}
  .btn:hover{color:var(--ink);border-color:var(--muted)}
  .btn[aria-pressed="false"]{opacity:.45}

  /* the viewport */
  .view{position:relative;height:min(74vh,760px);overflow:hidden;background:var(--paper);
        background-image:radial-gradient(var(--line) 1px,transparent 1px);background-size:22px 22px;
        cursor:grab;touch-action:none}
  .view.drag{cursor:grabbing}
  #world{position:absolute;top:0;left:0;transform-origin:0 0;will-change:transform}
  #wires{position:absolute;top:0;left:0;overflow:visible;pointer-events:none}
  .wire{fill:none;stroke:var(--edge);stroke-width:1.5;transition:stroke .12s,stroke-width .12s,opacity .12s}
  .wire.soft{stroke-dasharray:5 4}
  .wire.mute{opacity:.12}
  .wire.on{stroke-width:2.4}

  .card{position:absolute;width:232px;background:var(--surface);border:1.5px solid var(--line);
        border-radius:12px;padding:13px 15px 15px;cursor:pointer;
        box-shadow:0 1px 2px rgba(20,28,36,.05),0 10px 22px -16px rgba(20,28,36,.5);
        transition:opacity .12s,border-color .12s,transform .12s}
  .card:hover{transform:translateY(-2px)}
  .card.mute{opacity:.16}
  .card.on{border-width:2px}
  .card .chip{display:inline-block;font-family:"IBM Plex Mono",monospace;font-size:9.5px;font-weight:600;
        letter-spacing:.1em;text-transform:uppercase;padding:3px 8px;border-radius:20px;margin-bottom:9px}
  .card h3{margin:0 0 5px;font-family:Archivo,sans-serif;font-size:15.5px;font-weight:700;letter-spacing:-.01em;
        line-height:1.25;overflow-wrap:anywhere}
  .card p{margin:0;font-size:12.5px;color:var(--ink-soft);line-height:1.42}
  .card .foot{margin-top:9px;font-family:"IBM Plex Mono",monospace;font-size:10px;color:var(--muted);
        display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .card .dot{width:6px;height:6px;border-radius:50%;display:inline-block}
  .card.planned{background:var(--sunk);border-style:dashed}
  .card.planned h3{color:var(--muted)}

  .lane{position:absolute;font-family:"IBM Plex Mono",monospace;font-size:10px;letter-spacing:.16em;
        text-transform:uppercase;color:var(--muted);pointer-events:none;white-space:nowrap}

  .hint{background:var(--chrome);border-top:1.5px solid var(--line);padding:9px 14px;text-align:center;
        font-family:"IBM Plex Mono",monospace;font-size:11.5px;color:var(--muted)}

  /* detail */
  .detail{position:absolute;top:14px;right:14px;width:290px;max-height:calc(100% - 28px);overflow:auto;
        background:var(--surface);border:1.5px solid var(--line);border-radius:12px;padding:16px;
        box-shadow:0 18px 44px -20px rgba(20,28,36,.55);display:none;flex-direction:column;gap:9px}
  .detail.show{display:flex}
  .detail .x{position:absolute;top:11px;right:12px;cursor:pointer;color:var(--muted);font-size:15px;line-height:1}
  .detail h2{margin:0;font-family:Archivo,sans-serif;font-size:16.5px;font-weight:700;letter-spacing:-.01em;
        padding-right:20px;overflow-wrap:anywhere}
  .detail dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:4px 10px;font-size:12px}
  .detail dt{color:var(--muted);font-family:"IBM Plex Mono",monospace;font-size:9.5px;text-transform:uppercase;letter-spacing:.08em;padding-top:2px}
  .detail dd{margin:0;overflow-wrap:anywhere}
  .detail h4{margin:7px 0 0;font-family:"IBM Plex Mono",monospace;font-size:9.5px;letter-spacing:.12em;
        text-transform:uppercase;color:var(--muted);font-weight:600}
  .detail ul{margin:0;padding-left:15px;font-size:12px;display:flex;flex-direction:column;gap:2px}
  .detail .none{color:var(--muted);font-size:12px;font-style:italic}
  code{font-family:"IBM Plex Mono",monospace;font-size:11px;background:var(--sunk);padding:1px 4px;border-radius:3px}

  /* header strip */
  .top{display:flex;gap:16px;align-items:flex-end;flex-wrap:wrap}
  .top h1{margin:0;font-family:Archivo,sans-serif;font-size:clamp(22px,3vw,30px);font-weight:800;letter-spacing:-.025em}
  .top .stamp{font-family:"IBM Plex Mono",monospace;font-size:11px;color:var(--muted)}
  .prog{margin-left:auto;display:flex;gap:14px;flex-wrap:wrap}
  .pg{min-width:132px;display:flex;flex-direction:column;gap:5px}
  .pg .l{font-family:"IBM Plex Mono",monospace;font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;font-weight:600}
  .pg .t{display:flex;height:7px;border-radius:4px;overflow:hidden;background:var(--line)}
  .pg .t i{display:block}
  .pg .n{font-family:"IBM Plex Mono",monospace;font-size:10.5px;color:var(--muted)}
  .note{font-size:13px;color:var(--ink-soft);max-width:76ch;margin:0}
  .note b{color:var(--ink);font-weight:600}
</style>

<div class="shell">
  <div class="top">
    <div>
      <h1>ICM Architecture Map</h1>
      <div class="stamp" id="stamp"></div>
    </div>
    <div class="prog" id="prog"></div>
  </div>

  <div class="win">
    <div class="bar">
      <div class="dots"><i></i><i></i><i></i></div>
      <span class="name">ua-icm — architecture</span>
      <div class="right">
        <span class="btn" data-filter="page" aria-pressed="true">pages</span>
        <span class="btn" data-filter="automation" aria-pressed="true">automations</span>
        <span class="btn" data-filter="object" aria-pressed="true">objects</span>
        <span class="btn" data-filter="planned" aria-pressed="true">planned</span>
        <span class="btn" id="fit">fit</span>
      </div>
    </div>
    <div class="view" id="view">
      <div id="world"><svg id="wires"></svg></div>
      <div class="detail" id="detail"></div>
    </div>
    <div class="hint">drag to pan · scroll to zoom · hover to trace · click a card for detail</div>
  </div>

  <p class="note"><b>Nothing here is hand-drawn.</b> <code>scripts/graph.mjs</code> derives every node and edge from the repo itself — entity snapshots for objects and their foreign keys, automation snapshots for what each one reads and calls and whether it is really deployed, <code>docs/pages/</code> for the page→callable dependencies that the platform records nowhere, <code>tests/</code> for suites, and the domain model for what is proposed but unbuilt. If something is missing from this picture, record it in one of those places; never edit this file. Regenerate it with <code>scripts/graph.mjs</code> whenever you change what it is derived from; <code>--check</code> fails when it is stale.</p>
</div>

<script id="graph-data" type="application/json">${data}</script>
<script>
(function(){
  var G=JSON.parse(document.getElementById('graph-data').textContent);
  var LANES=[{k:'page',t:'Pages · what people open'},
             {k:'automation',t:'Automations · the API layer'},
             {k:'object',t:'Objects · the data'}];
  var ST={live:'live',ready:'spec + suite, deployable',draft:'draft only — no spec or suite',
          planned:'planned, not built',missing:'REFERENCED BUT NOT SNAPSHOTTED'};
  var show={page:true,automation:true,object:true,planned:true};
  var pinned=null;

  document.getElementById('stamp').textContent='generated '+G.generated.replace('T',' ').slice(0,16)+' UTC · '+G.generator;

  var prog=document.getElementById('prog');
  LANES.forEach(function(l){
    var c=G.counts[l.k]; if(!c) return;
    var order=['live','ready','draft','planned','missing'];
    var seg=order.filter(function(s){return c[s];}).map(function(s){
      return '<i style="width:'+(c[s]/c.total*100)+'%;background:var(--'+s+')"></i>';}).join('');
    var d=document.createElement('div'); d.className='pg';
    d.innerHTML='<div class="l" style="color:var(--'+l.k+')">'+l.k+'s</div><div class="t">'+seg+'</div>'+
                '<div class="n">'+(c.live||0)+' of '+c.total+' live</div>';
    prog.appendChild(d);
  });

  var view=document.getElementById('view'), world=document.getElementById('world');
  var wires=document.getElementById('wires'), detail=document.getElementById('detail');
  var NS='http://www.w3.org/2000/svg';
  var esc=function(s){return String(s).replace(/[&<>"]/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});};
  var byId=function(id){for(var i=0;i<G.nodes.length;i++) if(G.nodes[i].id===id) return G.nodes[i]; return null;};
  var nameOf=function(id){var n=byId(id);return n?n.label:id;};

  var W=232,H=118,GX=44,GY=40,LANEGAP=118,PAD=70,PERROW=5;
  var pos={},cards={},visible=[],bounds={w:0,h:0};

  function blurb(n){
    var m=n.meta||{};
    if(n.kind==='object'){
      if(n.status==='planned') return 'Proposed in the domain model. Not built.';
      var fn=(m.fieldNames||[]).slice(0,4).join(' · ');
      return fn||'No declared fields.';
    }
    if(n.kind==='automation'){
      var i=(m.inputs||[]).join(', ')||'no inputs';
      var o=(m.outputs||[]).slice(0,3).join(', ')||'no declared result';
      return i+' → '+o;
    }
    var out=G.edges.filter(function(e){return e.from===n.id;});
    return out.length? 'Calls '+out.length+' callable'+(out.length>1?'s':'')+'.' : 'Calls nothing yet.';
  }
  function footline(n){
    var m=n.meta||{},bits=[];
    if(n.kind==='automation'){
      bits.push((m.nodes||0)+' nodes');
      bits.push(m.spec?'spec':'no spec');
      bits.push(m.suite?'suite':'no suite');
    } else if(n.kind==='object'){
      if(m.fields) bits.push(m.fields+' fields');
      if(m.unique&&m.unique.length) bits.push('unique '+m.unique.join('+'));
    }
    return bits.join(' · ');
  }

  function layout(){
    pos={};visible=[];
    var y=PAD, maxX=0;
    LANES.forEach(function(l){
      var set=G.nodes.filter(function(n){
        return n.kind===l.k && show[n.kind] && !(n.status==='planned' && !show.planned);});
      if(!set.length){ l._skip=true; return; }
      l._skip=false; l._y=y;
      set.forEach(function(n,i){
        var r=Math.floor(i/PERROW), c=i%PERROW;
        pos[n.id]={x:PAD+c*(W+GX), y:y+r*(H+GY), n:n};
        maxX=Math.max(maxX,PAD+c*(W+GX)+W);
        visible.push(n);
      });
      var rows=Math.ceil(set.length/PERROW);
      y+=rows*(H+GY)+LANEGAP;
    });
    bounds={w:maxX+PAD, h:y-LANEGAP+PAD};
  }

  function build(){
    layout();
    world.querySelectorAll('.card,.lane').forEach(function(e){e.remove()});
    while(wires.firstChild) wires.removeChild(wires.firstChild);
    wires.setAttribute('width',bounds.w); wires.setAttribute('height',bounds.h);
    world.style.width=bounds.w+'px'; world.style.height=bounds.h+'px';
    cards={};

    LANES.forEach(function(l){
      if(l._skip) return;
      var d=document.createElement('div'); d.className='lane';
      d.style.left=PAD+'px'; d.style.top=(l._y-24)+'px'; d.textContent=l.t;
      d.style.color='var(--'+l.k+')'; world.appendChild(d);
    });

    G.edges.forEach(function(e){
      var a=pos[e.from],b=pos[e.to]; if(!a||!b) return;
      var p;
      if(e.from===e.to){
        var cx=a.x+W/2;
        p='M'+(cx-22)+' '+a.y+' C '+(cx-40)+' '+(a.y-44)+', '+(cx+40)+' '+(a.y-44)+', '+(cx+22)+' '+a.y;
      } else {
        var x1=a.x+W/2,y1=a.y+H,x2=b.x+W/2,y2=b.y;
        if(b.y<a.y){y1=a.y;y2=b.y+H;}
        var m=(y1+y2)/2;
        p='M'+x1+' '+y1+' C '+x1+' '+m+', '+x2+' '+m+', '+x2+' '+y2;
      }
      var path=document.createElementNS(NS,'path');
      path.setAttribute('d',p);
      path.setAttribute('class','wire'+(e.kind==='fk'?' soft':''));
      path.dataset.from=e.from; path.dataset.to=e.to;
      wires.appendChild(path);
    });

    visible.forEach(function(n){
      var p=pos[n.id];
      var el=document.createElement('div');
      el.className='card'+(n.status==='planned'?' planned':'');
      el.style.left=p.x+'px'; el.style.top=p.y+'px';
      el.style.borderColor='var(--'+n.status+')';
      var fl=footline(n);
      el.innerHTML='<span class="chip" style="background:var(--'+n.kind+'-bg);color:var(--'+n.kind+')">'+n.kind+'</span>'+
        '<h3>'+esc(n.label)+'</h3><p>'+esc(blurb(n))+'</p>'+
        '<div class="foot"><span class="dot" style="background:var(--'+n.status+')"></span>'+
        '<span style="color:var(--'+n.status+')">'+n.status+'</span>'+(fl?'<span>'+esc(fl)+'</span>':'')+'</div>';
      el.addEventListener('mouseenter',function(){if(!pinned) trace(n.id);});
      el.addEventListener('mouseleave',function(){if(!pinned) clear();});
      el.addEventListener('click',function(ev){ev.stopPropagation();pinned=n.id;trace(n.id);describe(n);});
      world.appendChild(el);
      cards[n.id]=el;
    });
  }

  function trace(id){
    var keep={};keep[id]=true;
    G.edges.forEach(function(e){if(e.from===id)keep[e.to]=true;if(e.to===id)keep[e.from]=true;});
    Object.keys(cards).forEach(function(k){
      cards[k].classList.toggle('mute',!keep[k]);
      cards[k].classList.toggle('on',k===id);
    });
    wires.querySelectorAll('.wire').forEach(function(w){
      var on=w.dataset.from===id||w.dataset.to===id;
      w.classList.toggle('mute',!on); w.classList.toggle('on',on);
      w.setAttribute('stroke',on?'var(--'+byId(id).kind+')':'var(--edge)');
    });
  }
  function clear(){
    Object.keys(cards).forEach(function(k){cards[k].classList.remove('mute','on')});
    wires.querySelectorAll('.wire').forEach(function(w){
      w.classList.remove('mute','on'); w.setAttribute('stroke','var(--edge)');});
  }

  function describe(n){
    var out=G.edges.filter(function(e){return e.from===n.id;});
    var inc=G.edges.filter(function(e){return e.to===n.id;});
    var m=n.meta||{};
    var h='<span class="x" id="dx">✕</span><h2>'+esc(n.label)+'</h2><dl>';
    h+='<dt>kind</dt><dd style="color:var(--'+n.kind+')">'+n.kind+'</dd>';
    h+='<dt>status</dt><dd style="color:var(--'+n.status+')"><strong>'+ST[n.status]+'</strong></dd>';
    if(m.workflowId) h+='<dt>id</dt><dd><code>'+m.workflowId+'</code></dd>';
    if(m.version!=null) h+='<dt>version</dt><dd>'+m.version+'</dd>';
    if(m.nodes) h+='<dt>nodes</dt><dd>'+m.nodes+'</dd>';
    if(m.fields) h+='<dt>fields</dt><dd>'+m.fields+'</dd>';
    if(m.unique&&m.unique.length) h+='<dt>unique</dt><dd>'+m.unique.map(function(u){return '<code>'+esc(u)+'</code>';}).join(' ')+'</dd>';
    if(n.kind==='automation'){
      h+='<dt>spec</dt><dd>'+(m.spec?'<code>'+esc(m.spec)+'</code>':'<span style="color:var(--draft)">none</span>')+'</dd>';
      h+='<dt>suite</dt><dd>'+(m.suite?'<code>'+esc(m.suite)+'</code>':'<span style="color:var(--draft)">none</span>')+'</dd>';
      h+='<dt>live</dt><dd>'+(m.deployed?'deployed':'<span style="color:var(--draft)">no — callers cannot reach it</span>')+'</dd>';
    }
    if(n.kind==='page'&&m.spec) h+='<dt>spec</dt><dd><code>'+esc(m.spec)+'</code></dd>';
    h+='</dl>';
    if(m.fieldNames&&m.fieldNames.length) h+='<h4>fields</h4><ul><li>'+m.fieldNames.map(esc).join('</li><li>')+'</li></ul>';
    if(m.inputs&&m.inputs.length) h+='<h4>takes</h4><ul><li>'+m.inputs.map(esc).join('</li><li>')+'</li></ul>';
    if(m.outputs&&m.outputs.length) h+='<h4>returns</h4><ul><li>'+m.outputs.map(esc).join('</li><li>')+'</li></ul>';
    h+='<h4>depends on ('+out.length+')</h4>';
    h+=out.length?'<ul>'+out.map(function(e){return '<li>'+esc(nameOf(e.to))+' <span style="color:var(--muted)">'+e.kind+(e.label?' · '+esc(e.label):'')+'</span></li>';}).join('')+'</ul>':'<p class="none">nothing</p>';
    h+='<h4>depended on by ('+inc.length+')</h4>';
    h+=inc.length?'<ul>'+inc.map(function(e){return '<li>'+esc(nameOf(e.from))+' <span style="color:var(--muted)">'+e.kind+'</span></li>';}).join('')+'</ul>':'<p class="none">nothing yet</p>';
    detail.innerHTML=h; detail.classList.add('show');
    document.getElementById('dx').addEventListener('click',function(ev){
      ev.stopPropagation();detail.classList.remove('show');pinned=null;clear();});
  }

  /* ---- pan + zoom ---- */
  var tx=0,ty=0,sc=1;
  function apply(){world.style.transform='translate('+tx+'px,'+ty+'px) scale('+sc+')';}
  function fit(){
    var r=view.getBoundingClientRect();
    sc=Math.min(1,Math.min(r.width/bounds.w,r.height/bounds.h))||1;
    if(sc>1)sc=1;
    tx=(r.width-bounds.w*sc)/2; ty=(r.height-bounds.h*sc)/2;
    if(tx<0)tx=0; if(ty<0)ty=0;
    apply();
  }
  var down=false,sx=0,sy=0,ox=0,oy=0,moved=false;
  view.addEventListener('pointerdown',function(e){
    if(e.target.closest('.detail'))return;
    down=true;moved=false;sx=e.clientX;sy=e.clientY;ox=tx;oy=ty;
    view.classList.add('drag');view.setPointerCapture(e.pointerId);
  });
  view.addEventListener('pointermove',function(e){
    if(!down)return;
    var dx=e.clientX-sx,dy=e.clientY-sy;
    if(Math.abs(dx)+Math.abs(dy)>3)moved=true;
    tx=ox+dx;ty=oy+dy;apply();
  });
  view.addEventListener('pointerup',function(e){
    down=false;view.classList.remove('drag');
    if(!moved&&!e.target.closest('.card')&&!e.target.closest('.detail')){
      pinned=null;clear();detail.classList.remove('show');
    }
  });
  view.addEventListener('wheel',function(e){
    e.preventDefault();
    var r=view.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;
    var f=Math.exp(-e.deltaY*0.0016), ns=Math.max(0.3,Math.min(2.2,sc*f));
    tx=mx-(mx-tx)*(ns/sc); ty=my-(my-ty)*(ns/sc); sc=ns; apply();
  },{passive:false});

  document.querySelectorAll('.btn[data-filter]').forEach(function(b){
    b.addEventListener('click',function(){
      var k=b.dataset.filter; show[k]=!show[k];
      b.setAttribute('aria-pressed',show[k]?'true':'false');
      pinned=null;detail.classList.remove('show');build();fit();
    });
  });
  document.getElementById('fit').addEventListener('click',fit);
  window.addEventListener('resize',fit);

  build();fit();
})();
</script>
`;
}

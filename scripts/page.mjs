#!/usr/bin/env node
// One entry point for page work, so it can happen HERE instead of in a second
// Claude Code session with its own context.
//
//   node scripts/page.mjs up                    start the tool server + wire .mcp.json
//   node scripts/page.mjs status                is the server up, what sessions are open
//   node scripts/page.mjs start <builder-url>   SNAPSHOT the page, then open a session
//   node scripts/page.mjs restore --page <id>   put the page back as it was at start
//   node scripts/page.mjs trace --page <id> --note "..."   write the session record
//
// WHY THIS EXISTS. The page-builder tools and the safety commands live in
// `ua-agent-devkit`. Its tools are just an HTTP MCP server, so any Claude Code
// session can use them once `.mcp.json` points at it — but the SAFETY is in its
// bin scripts, and those are what make a page edit reversible:
//
//   start    snapshots the page BEFORE anything touches it
//   restore  the ONLY per-page undo that exists (platform history restores the
//            WHOLE app, not one page)
//   trace    writes the session record so the next person can debug it
//
// So this script does not reimplement any of that. It runs the devkit's own
// scripts with the devkit as cwd, and copies its generated `.mcp.json` here.
// One context, same guarantees, nothing forked.
//
// The devkit path comes from kit.config.json (`pages.devkitDir`) or the
// UA_DEVKIT_DIR environment variable. Nothing here is hardcoded.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config } from "./kit-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const die = (m) => { console.error(`error: ${m}`); process.exit(1); };

const DEVKIT = path.resolve(
  ROOT,
  process.env.UA_DEVKIT_DIR || config.pages?.devkitDir || "../ua-agent-devkit",
);

if (!fs.existsSync(path.join(DEVKIT, "bin", "serve"))) {
  die(
    `no devkit at ${DEVKIT}\n` +
      `  Set pages.devkitDir in kit.config.json, or UA_DEVKIT_DIR, to your\n` +
      `  ua-agent-devkit clone. Setup is in the README.`,
  );
}

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd: DEVKIT, stdio: "inherit", ...opts });

// The devkit writes its own .mcp.json (server url + the Cookie header) every
// time the server starts. We copy it rather than build our own, so the two can
// never disagree about the port or the credential.
function wireMcp() {
  const src = path.join(DEVKIT, ".mcp.json");
  if (!fs.existsSync(src)) die(`${src} not found - run \`page.mjs up\` first`);
  const dst = path.join(ROOT, ".mcp.json");
  fs.writeFileSync(dst, fs.readFileSync(src));
  fs.chmodSync(dst, 0o600);          // it carries a live session cookie
  const cfg = JSON.parse(fs.readFileSync(dst, "utf8"));
  const url = cfg.mcpServers?.["page-builder"]?.url ?? "?";
  console.log(`\nwired .mcp.json -> ${url}  (chmod 600, git-ignored)`);
  console.log(`Restart Claude Code for it to pick the servers up: ${Object.keys(cfg.mcpServers ?? {}).join(", ")}`);
}

const [verb, ...rest] = process.argv.slice(2);

switch (verb) {
  case "up":
    run("bin/serve", ["start"]);
    wireMcp();
    break;
  case "wire":
    wireMcp();
    break;
  case "status":
    run("bin/serve", ["status"]);
    for (const f of fs.existsSync(path.join(DEVKIT, ".sessions"))
      ? fs.readdirSync(path.join(DEVKIT, ".sessions")).filter((x) => x.endsWith(".json"))
      : []) {
      const s = JSON.parse(fs.readFileSync(path.join(DEVKIT, ".sessions", f), "utf8"));
      console.log(`  session ${f.replace(/\.json$/, "")}  ${s.pageName ?? ""}  ${s.dir ?? ""}`);
    }
    break;
  case "start":
    if (!rest.length) die("usage: page.mjs start <builder-url> [name]");
    run("bin/serve", ["status"]).status === 0 || run("bin/serve", ["start"]);
    run("node", ["bin/start.mjs", ...rest]);
    break;
  case "restore":
    run("node", ["bin/restore.mjs", ...rest]);   // prompts; never pass --yes for the user
    break;
  case "trace":
  case "done":
    run("node", ["bin/trace.mjs", ...rest]);
    break;
  default:
    console.log(
      "verbs: up | wire | status | start <builder-url> | restore --page <id> | trace --page <id> --note \"...\"",
    );
    console.log(`devkit: ${DEVKIT}`);
    process.exit(verb ? 1 : 0);
}

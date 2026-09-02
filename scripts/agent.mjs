#!/usr/bin/env node
// Talk to the text-to-workflow copilot agent in the automation builder.
// This CAN cause edits to the automation you point it at - only use it on
// clones/test automations unless everyone agreed otherwise.
//
//   node scripts/agent.mjs send --workflow <workflowId> [--case <caseId>] "message"
//
// With no --case a new chat is started (caseId "new"); the real case id is
// printed so you can continue the same chat with --case.
// Raw stream events are appended to scratch log files under /tmp-like dirs are
// avoided: they go to .agent-logs/ (git-ignored).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Fixed platform ids for the builder copilot, taken from a real browser call
// on orbit (frontend constant STORYBOOK_RESUME_SSE_AUTOMATION_ID matches).
const COPILOT_AUTOMATION_ID = "67bdf597ba32d908560a680f";
const COPILOT_AI_AGENT_ID = "e_69e8f53f7b11356004965425";

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function loadEnvFile() {
  const file = path.join(ROOT, ".env.local");
  if (!fs.existsSync(file)) die(`.env.local not found at ${file}`);
  const vars = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && !line.trim().startsWith("#")) vars[m[1]] = m[2];
  }
  return vars;
}

const args = process.argv.slice(2);
function takeFlag(name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

const envName = takeFlag("--env") ?? null;
const workflowFlag = takeFlag("--workflow");
const caseId = takeFlag("--case") ?? "new";
const [command, message] = args;

const vars = loadEnvFile();
// --workflow wins; UA_WORKFLOW_ID in .env.local is a convenience default for
// when you are editing the same automation all session.
const workflowId = workflowFlag || vars.UA_WORKFLOW_ID || null;
const env = envName || vars.UA_DEFAULT_ENV || "orbit";
const baseUrl = vars[env === "orbit" ? "UA_ORBIT_URL" : "UA_TOOL_URL"];
const cookie = vars[env === "orbit" ? "UA_ORBIT_COOKIE" : "UA_TOOL_COOKIE"];
if (!baseUrl || !cookie) die(`missing url or cookie for env "${env}"`);
const host = new URL(baseUrl).host;

if (command !== "send" || !message || !workflowId) {
  die('usage: node scripts/agent.mjs send --workflow <workflowId> [--case <caseId>] "message"');
}

const body = {
  context: {
    appName: "callables",
    resourceName: "callables_call_automation_streaming",
  },
  inputs: {
    automationId: COPILOT_AUTOMATION_ID,
    synchronous: true,
    debugParams: { createCase: COPILOT_AUTOMATION_ID },
    parameters: {
      copilotType: "AI_AGENT",
      // Backend rule (SessionStarter.resolveCase in uacode): a BLANK caseId
      // creates a new case; any non-blank value is used as-is. So for a new
      // chat we omit the field entirely - never send the literal "new".
      ...(caseId === "new" ? {} : { caseId }),
      message,
      messageContentType: "MARKDOWN",
      aiAgentId: COPILOT_AI_AGENT_ID,
      runtimeContext: { workflowId, host },
      timezoneId: "Asia/Calcutta",
    },
  },
};

const logDir = path.join(ROOT, ".agent-logs");
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, `${Date.now()}-${workflowId}.ndjson`);

console.log(`sending to ${env} copilot | workflow ${workflowId} | case ${caseId}`);
console.log(`raw events -> ${path.relative(ROOT, logFile)}`);

const res = await fetch(`${baseUrl}/api/workflow/execute/node/sse`, {
  method: "POST",
  headers: {
    cookie: `_at=${cookie}`,
    "content-type": "application/json",
    accept: "text/event-stream",
  },
  body: JSON.stringify(body),
});
if (!res.ok) die(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);

let discoveredCaseId = null;
const texts = new Map(); // messageId -> latest text, so we print final versions

const decoder = new TextDecoder();
let buffer = "";

function handleEvent(raw) {
  if (!raw.trim()) return;
  fs.appendFileSync(logFile, raw + "\n");
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return;
  }
  walk(obj);
}

function walk(o) {
  if (Array.isArray(o)) return o.forEach(walk);
  if (!o || typeof o !== "object") return;
  if (typeof o.caseId === "string" && o.caseId.startsWith("e_") && !discoveredCaseId)
    discoveredCaseId = o.caseId;
  // Collect anything that looks like message content
  const id = o.messageId || o.id;
  for (const key of ["content", "text", "message"]) {
    if (typeof o[key] === "string" && o[key].length > 1) {
      texts.set(id ?? o[key].slice(0, 20), o[key]);
    }
  }
  Object.values(o).forEach(walk);
}

for await (const chunk of res.body) {
  buffer += decoder.decode(chunk, { stream: true });
  let idx;
  while ((idx = buffer.indexOf("\n\n")) !== -1) {
    const eventBlock = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    for (const line of eventBlock.split("\n")) {
      if (line.startsWith("data:")) handleEvent(line.slice(5).trim());
    }
  }
}
for (const line of buffer.split("\n")) {
  if (line.startsWith("data:")) handleEvent(line.slice(5).trim());
}

console.log("\n--- stream ended ---");
if (discoveredCaseId) console.log(`case id: ${discoveredCaseId}  (continue with --case ${discoveredCaseId})`);
const unique = [...new Set(texts.values())];
if (unique.length === 0) {
  console.log("no readable message text found - inspect the raw log file");
} else {
  console.log("agent said (latest versions):\n");
  for (const t of unique.slice(-5)) {
    console.log(t);
    console.log("\n---\n");
  }
}

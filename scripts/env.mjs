// The ONE definition of how a script chooses an environment, in the same spirit as
// field-types.mjs: two copies of this logic is two chances for them to disagree, and
// the thing they would disagree about is which platform a write lands on.
//
// Before 2026-09-05 there were three conventions living side by side. `ua.mjs` took an
// explicit `--env`; `regress`/`testrun`/`lint`/`debugrun` silently followed
// `UA_DEFAULT_ENV` with no flag at all; and every write script refused `tool` outright.
// That mix had a sharp edge: the only way to run a suite against production was to flip
// UA_DEFAULT_ENV in .env.local, which silently repointed every other script in the repo
// at production too - the exact accident the write guards existed to prevent.
//
// One rule now, for every script:
//
//   --env orbit|tool   on the command line, wins over everything
//   UA_DEFAULT_ENV     otherwise
//   orbit              otherwise
//
// and one extra rule for anything that WRITES: production must be typed. `write: true`
// refuses to resolve `tool` unless `--env tool` is literally on the command line, so a
// stale default in .env.local can never point a create, an update or a deploy at prod.
//
// Reads are not gated that way on purpose. Reading production is how you check what is
// there, it changes nothing, and making it awkward only teaches people to flip the
// default - which is what we are trying to stop.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Parse .env.local with the same small regex every script used before. Not dotenv. */
export function readEnvFile(file = path.join(ROOT, ".env.local")) {
  if (!fs.existsSync(file)) {
    console.error(`error: ${file} not found - copy .env.example and paste your cookies`);
    process.exit(1);
  }
  const vars = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && !line.trim().startsWith("#")) vars[m[1]] = m[2];
  }
  return vars;
}

/**
 * Resolve the target environment.
 *
 * @param {object}   [opts]
 * @param {boolean}  [opts.write]  this script changes the platform - require an explicit
 *                                 `--env tool` before it will touch production
 * @param {string[]} [opts.argv]   defaults to process.argv.slice(2)
 * @returns {{env: string, baseUrl: string, cookie: string, headers: object,
 *            args: string[], vars: object, explicit: boolean}}
 *          `args` is argv with the `--env <value>` pair removed, so callers can keep
 *          reading their positional arguments exactly as they did before.
 */
export function resolveEnv({ write = false, argv = process.argv.slice(2) } = {}) {
  const vars = readEnvFile();
  const die = (m) => { console.error(`error: ${m}`); process.exit(1); };

  const i = argv.indexOf("--env");
  const explicitValue = i !== -1 ? argv[i + 1] : undefined;
  if (i !== -1 && !explicitValue) die("--env needs a value (orbit|tool)");
  const args = i === -1 ? [...argv] : [...argv.slice(0, i), ...argv.slice(i + 2)];

  const env = explicitValue || vars.UA_DEFAULT_ENV || "orbit";
  if (env !== "orbit" && env !== "tool") die(`unknown env "${env}" (orbit|tool)`);

  if (write && env === "tool" && explicitValue !== "tool") {
    die(
      "refusing to write to tool (production) from UA_DEFAULT_ENV alone - " +
        "pass --env tool explicitly, so that a default in .env.local can never do it for you",
    );
  }

  const baseUrl = env === "tool" ? vars.UA_TOOL_URL : vars.UA_ORBIT_URL;
  const cookie = env === "tool" ? vars.UA_TOOL_COOKIE : vars.UA_ORBIT_COOKIE;
  const pair = env === "tool" ? "UA_TOOL_URL / UA_TOOL_COOKIE" : "UA_ORBIT_URL / UA_ORBIT_COOKIE";
  if (!baseUrl || !cookie) die(`missing ${pair} in .env.local for env "${env}"`);

  return {
    env,
    baseUrl,
    cookie,
    headers: { cookie: `_at=${cookie}`, "content-type": "application/json" },
    args,
    vars,
    explicit: explicitValue !== undefined,
  };
}

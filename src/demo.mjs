// Bun consumer of oresoftware/flags-2-env.
//
// Asserts the contract in EXPECTED.md. Exits non-zero on the first
// disagreement, which is what makes `docker run` the whole test.

import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const repo = dirname(import.meta.dir);
const vendor = join(repo, ".vendor/.zed/oresoftware/flags-2-env");

// The Bun client uses bun:ffi over the same shared library the Python, Ruby,
// PHP, Dart, and Deno clients load -- it is a distinct binding, not a re-export
// of the Node one, because bun:ffi and N-API resolve symbols differently.
const { parse } = await import(pathToFileURL(join(vendor, "clients/bun/lib.mjs")).href);

const configPath = join(repo, ".cli-flags.toml");

const defaults = { PORT: "3000", DEBUG: "false", APP_ENV: "development", COLOR: "true" };
const overridden = { PORT: "8181", DEBUG: "true", APP_ENV: "production", COLOR: "true" };

const cases = [
  ["defaults", [], defaults],
  ["long flags", ["--port", "8181", "--debug=t", "--mode", "production"], overridden],
  ["short flags", ["-p", "8181", "-d", "1", "--env", "production"], overridden],
  ["long aliases", ["--listen-port", "8181", "--debug", "1", "--mode", "production"], overridden],
  ["joined by =", ["--port=8181", "--debug=yes", "--mode=production"], overridden],
  ["negation", ["--no-color"], { ...defaults, COLOR: "false" }],
];

let failures = 0;

for (const [label, flags, expected] of cases) {
  const got = parse(["demo", ...flags], { configPath });
  const keys = Object.keys(expected).sort();
  const ok = keys.every((key) => got[key] === expected[key]) &&
    Object.keys(got).length === keys.length;

  if (!ok) failures += 1;
  console.log(`${(ok ? "ok" : "FAIL").padEnd(4)} ${label.padEnd(13)} demo ${flags.join(" ")}`);
  for (const key of keys) console.log(`       ${key}=${got[key] ?? "<missing>"}`);
  if (!ok) {
    console.error(`       expected ${JSON.stringify(expected)}`);
    console.error(`       got      ${JSON.stringify(got)}`);
  }
}

if (failures > 0) {
  console.error(`\nbun-app: ${failures} of ${cases.length} cases disagree with the contract`);
  process.exit(1);
}

console.log(`\nbun-app OK: ${cases.length} cases, via bun:ffi into oresoftware/flags-2-env`);

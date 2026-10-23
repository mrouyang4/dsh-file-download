#!/usr/bin/env node
/**
 * Conformance check against the DSH plugin contract.
 *
 * The contract has four parts, and this script asserts all of them:
 *
 *   1. Host entry is a Cordis plugin: named exports `name`, `inject`, `apply`.
 *   2. package.json declares where the host and client entries live, and that
 *      the client half targets the web platform.
 *   3. The client entry is a browser module bundle (`__ModuleLoader__`) that
 *      exposes the same `name` / `apply` / `inject` shape.
 *   4. Display metadata ships as locale dictionaries, one per supported locale.
 *
 * Run: node scripts/conformance.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const failures = [];
const checks = [];
const ok = (label, detail = "") => checks.push({ label, detail, pass: true });
const fail = (label, detail) => {
  checks.push({ label, detail, pass: false });
  failures.push(`${label}: ${detail}`);
};

/* 1. Host entry — Cordis plugin shape. ---------------------------------- */

const manifest = JSON.parse(read("package.json"));
const hostPath = manifest.main ?? "lib/index.js";
if (!existsSync(join(root, hostPath))) fail("host entry", `${hostPath} does not exist`);
const host = await import(new URL(`file://${join(root, hostPath)}`).href);

if (typeof host.name !== "string" || host.name.length === 0) {
  fail("host.name", "must be a non-empty string");
} else if (host.name !== manifest.name) {
  fail("host.name", `"${host.name}" should equal package name "${manifest.name}"`);
} else {
  ok("host.name", host.name);
}

if (!Array.isArray(host.inject) || host.inject.some((s) => typeof s !== "string")) {
  fail("host.inject", "must be an array of service names");
} else {
  ok("host.inject", host.inject.join(", "));
}

if (typeof host.apply !== "function") fail("host.apply", "must be a function");
else ok("host.apply", `injects ${host.inject.length} services`);

ok("host.Config", host.Config ? "declared" : "optional, not declared");

/* 2. Manifest — entry points and web client declaration. ----------------- */

const exportsMap = manifest.exports ?? {};
for (const key of [".", "./client", "./package.json", "./locale/*.json"]) {
  if (exportsMap[key]) ok(`exports["${key}"]`, String(exportsMap[key]));
  else fail(`exports["${key}"]`, "missing from package.json exports");
}

if (exportsMap["."] !== `./${hostPath}`) {
  fail("exports['.']", `should point at main (./${hostPath})`);
}

const clientFile = exportsMap["./client"];
if (typeof clientFile !== "string" || !existsSync(join(root, clientFile))) {
  fail("client entry", "exports['./client'] must name an existing file");
}

const dsh = manifest.dsh ?? {};
if (dsh.client?.platform !== "web") fail("dsh.client.platform", "must be \"web\"");
else ok("dsh.client.platform", "web");

if (!Array.isArray(dsh.client?.inject) || dsh.client.inject.length === 0) {
  fail("dsh.client.inject", "must list the client plugins this bundle extends");
} else {
  ok("dsh.client.inject", dsh.client.inject.join(", "));
}

/* 3. Client bundle — browser module module-loader shape. ------------------ */

if (clientFile) {
  const client = read(clientFile);
  if (client.includes("__ModuleLoader__.load(")) ok("client loader", "__ModuleLoader__.load");
  else fail("client loader", "bundle must register through window.__ModuleLoader__.load(...)");

  const idMatch = client.match(/id:\s*["']([^"']+)["']/);
  if (!idMatch) fail("client id", "bundle must declare an id");
  else if (idMatch[1] !== manifest.name) fail("client id", `"${idMatch[1]}" should equal "${manifest.name}"`);
  else ok("client id", idMatch[1]);

  for (const key of ["name", "apply", "inject"]) {
    if (new RegExp(`exports\\.${key}\\s*=`).test(client)) ok(`client.exports.${key}`, "present");
    else fail(`client.exports.${key}`, "missing");
  }
}

/* 4. Locale dictionaries — one per supported locale, same key set. ------- */

const localeNames = ["zh", "en"].filter((name) => existsSync(join(root, `locale/${name}.json`)));
const shapes = [];
for (const name of localeNames) {
  const dict = JSON.parse(read(`locale/${name}.json`));
  if (typeof dict.meta?.title !== "string" || typeof dict.meta?.description !== "string") {
    fail(`locale/${name}.json`, "must define meta.title and meta.description");
  }
  shapes.push([name, Object.keys(dict.meta ?? {}).sort().join(",")]);
}
if (shapes.length < 2) {
  fail("locale", "expected locale/zh.json and locale/en.json");
} else {
  const first = shapes[0][1];
  const mismatch = shapes.filter(([, keys]) => keys !== first);
  if (mismatch.length) fail("locale keys", `mismatched between ${shapes.map(([n]) => n).join("/")}`);
  else ok("locale", `${shapes.map(([n]) => n).join(" + ")} (${first})`);
}

/* Report. ---------------------------------------------------------------- */

const width = Math.max(...checks.map((c) => c.label.length));
for (const c of checks) {
  const mark = c.pass ? "ok  " : "FAIL";
  console.log(`${mark}  ${c.label.padEnd(width)}  ${c.detail}`);
}
console.log(
  failures.length === 0
    ? `\n符合 DSH 插件规范：${checks.length} 项全部通过`
    : `\n${failures.length} 项不符合规范：\n- ${failures.join("\n- ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);

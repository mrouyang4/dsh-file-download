#!/usr/bin/env bash
# Local pre-push checks (same steps as .github/workflows/check.yml).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== syntax =="
for f in lib/index.js lib/page.js lib/zip.js client/client.js; do
  node --check "$f"
  echo "  ok $f"
done

echo "== json =="
node -e 'for (const f of ["package.json","locale/zh.json","locale/en.json"]) JSON.parse(require("fs").readFileSync(f,"utf8")); console.log("  ok json")'

echo "== zip writer smoke test =="
node --input-type=module -e '
import { createReadStream, writeFileSync, mkdtempSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipEntries } from "./lib/zip.js";

const dir = mkdtempSync(join(tmpdir(), "dsh-zip-"));
writeFileSync(join(dir, "hello.txt"), "hello world");
const target = join(dir, "hello.txt");
const info = await stat(target);
const chunks = [];
for await (const chunk of zipEntries([{ name: "hello.txt", size: info.size, mtimeMs: info.mtimeMs, opened: () => createReadStream(target) }])) chunks.push(chunk);
const buf = Buffer.concat(chunks);
if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error("bad local file header");
const eocd = buf.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));
if (eocd < 0 || buf.readUInt16LE(eocd + 10) !== 1) throw new Error("bad end of central directory");
console.log("  ok zip", buf.length, "bytes");
'
echo "== DSH plugin conformance =="
node scripts/conformance.mjs

echo "all checks passed"

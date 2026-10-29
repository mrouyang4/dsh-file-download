#!/usr/bin/env bash
# Local pre-push checks (same steps as .github/workflows/check.yml).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== syntax =="
for f in lib/index.js lib/page.js lib/zip.js lib/xlsx.js lib/docx.js client/client.js; do
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
echo "== office parsers =="
node --input-type=module -e '
import { zipEntries } from "./lib/zip.js";
import { readWorkbook } from "./lib/xlsx.js";
import { readDocx, readPptx } from "./lib/docx.js";

// Build a tiny xlsx in memory: one sheet, two shared strings, one date style.
const parts = new Map([
  ["[Content_Types].xml", "<?xml version=\"1.0\"?><Types/>"],
  ["xl/workbook.xml", "<?xml version=\"1.0\"?><workbook><sheets><sheet name=\"S1\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>"],
  ["xl/_rels/workbook.xml.rels", "<?xml version=\"1.0\"?><Relationships><Relationship Id=\"rId1\" Target=\"worksheets/sheet1.xml\"/></Relationships>"],
  ["xl/sharedStrings.xml", "<sst><si><t>a&amp;b</t></si><si><t>c</t></si></sst>"],
  ["xl/styles.xml", "<styleSheet><cellXfs><xf numFmtId=\"0\"/><xf numFmtId=\"14\"/></cellXfs></styleSheet>"],
  ["xl/worksheets/sheet1.xml", "<worksheet><sheetData><row><c r=\"A1\" t=\"s\"><v>0</v></c><c r=\"B1\" s=\"1\"><v>45000</v></c></row><row><c r=\"A2\" t=\"s\"><v>1</v></c></row></sheetData></worksheet>"],
]);

const chunks = [];
for await (const chunk of zipEntries([...parts].map(([name, text]) => ({
  name, size: Buffer.byteLength(text), mtimeMs: 0, opened: () => [Buffer.from(text)],
})))) chunks.push(chunk);
const wb = readWorkbook(Buffer.concat(chunks));
const [sheet] = wb.sheets;
if (sheet.name !== "S1") throw new Error("sheet name lost");
if (sheet.rows[0][0] !== "a&b") throw new Error("shared string or entity decode failed");
if (!/^\d{4}-\d{2}-\d{2}/.test(sheet.rows[0][1])) throw new Error("date serial not converted: " + sheet.rows[0][1]);
if (sheet.rows[1][0] !== "c") throw new Error("second row lost");

const docx = readDocx(await zipOf([["word/document.xml",
  "<w:document><w:body><w:p><w:pPr><w:pStyle w:val=\"Heading1\"/></w:pPr><w:r><w:t>H</w:t></w:r></w:p>" +
  "<w:p><w:r><w:t>x</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>c1</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>"]]));
if (docx.blocks[0].kind !== "heading" || docx.blocks[0].level !== 1) throw new Error("heading lost");
if (docx.blocks[1].runs[0].text !== "x") throw new Error("paragraph lost");
if (docx.blocks[2].kind !== "table" || docx.blocks[2].rows[0][0] !== "c1") throw new Error("table cell lost");

const pptx = readPptx(await zipOf([
  ["ppt/presentation.xml", "<p:presentation><p:sldIdLst><p:sldId r:id=\"rId1\"/></p:sldIdLst></p:presentation>"],
  ["ppt/_rels/presentation.xml.rels", "<Relationships><Relationship Id=\"rId1\" Target=\"slides/slide1.xml\"/></Relationships>"],
  ["ppt/slides/slide1.xml", "<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>slide text</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>"],
]));
if (pptx.slides[0].lines[0].runs[0].text !== "slide text") throw new Error("slide text lost");

async function zipOf(pairs) {
  const chunks = [];
  for await (const chunk of zipEntries(pairs.map(([name, text]) => ({
    name, size: Buffer.byteLength(text), mtimeMs: 0, opened: () => [Buffer.from(text)],
  })))) chunks.push(chunk);
  return Buffer.concat(chunks);
}
console.log("  ok xlsx + docx + pptx");
'
echo "== DSH plugin conformance =="
node scripts/conformance.mjs

echo "all checks passed"

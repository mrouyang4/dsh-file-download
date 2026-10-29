/**
 * dsh-file-download — minimal XLSX reader.
 *
 * A spreadsheet is a ZIP of XML parts. Reading it here (instead of shipping a
 * 1 MB client library) keeps the plugin dependency-free while still giving the
 * file manager a real grid: sheet tabs, shared strings, inline strings, cached
 * formula values, and date-formatted cells turned back into readable dates.
 *
 * Only what a preview needs is implemented: no styles beyond number formats,
 * no charts, no pivot tables. Anything unexpected degrades to raw cell text
 * rather than throwing, because a preview that half-works beats a blank pane.
 *
 * @module
 */
import { inflateRawSync } from "node:zlib";

/** Hard caps so a 50 MB workbook cannot exhaust memory while previewing. */
const MAX_SHEETS = 20;
const MAX_ROWS = 2000;
const MAX_COLS = 200;

/** XLW-specific: the EOCD signature sits in the last 64 KiB at most. */
const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** Read one ZIP entry's uncompressed bytes out of the archive buffer. */
function unzipEntry(buffer, entry) {
  const offset = entry.localOffset;
  if (offset + 30 > buffer.length) throw new Error("zip: truncated local header");
  if (buffer.readUInt32LE(offset) !== LOCAL_SIG) throw new Error("zip: bad local header");
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > buffer.length) throw new Error("zip: truncated entry");
  const raw = buffer.subarray(start, end);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error("zip: unsupported compression " + entry.method);
}

/** Walk the central directory and return `{ name -> entry }`. */
function readEntries(buffer) {
  const scanFrom = Math.max(0, buffer.length - 65557);
  let eocd = -1;
  for (let index = buffer.length - 22; index >= scanFrom; index -= 1) {
    if (buffer.readUInt32LE(index) === EOCD_SIG) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip: no end-of-central-directory record");
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length) break;
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIG) break;
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    entries.set(name, { name, method, compressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Decode the five XML entities a spreadsheet part can legitimately carry. */
function decodeXml(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&");
}

/** Concatenate every `<t>` run inside a shared-string or inline-string node. */
function textRuns(xml) {
  const parts = [];
  const pattern = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let match;
  while ((match = pattern.exec(xml)) !== null) parts.push(decodeXml(match[1]));
  return parts.join("");
}

/** Column letters → zero-based index. */
function columnIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref);
  if (!letters) return -1;
  let index = 0;
  for (const char of letters[0]) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

/** Collect date-formatted style indices so serial numbers render as dates. */
function readDateStyles(stylesXml) {
  const custom = new Map();
  const fmtPattern = /<numFmt\s+numFmtId="(\d+)"\s+formatCode="([^"]*)"/g;
  let match;
  while ((match = fmtPattern.exec(stylesXml)) !== null) {
    custom.set(Number(match[1]), decodeXml(match[2]));
  }
  const builtinDates = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
  const dateStyles = new Set();
  const xfBlock = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
  if (xfBlock) {
    const xfPattern = /<xf\b[^>]*numFmtId="(\d+)"[^>]*\/?>/g;
    let xfIndex = 0;
    while ((match = xfPattern.exec(xfBlock[1])) !== null) {
      const id = Number(match[1]);
      const code = custom.get(id) ?? "";
      const looksDate = /(y+|m+|d+|h+|s+)/.test(code) && !/^[#0.,%\s]+$/.test(code);
      if (builtinDates.has(id) || looksDate) dateStyles.add(xfIndex);
      xfIndex += 1;
    }
  }
  return dateStyles;
}

/** Excel's 1900 date system, serial → `YYYY-MM-DD[ HH:mm]`. */
function serialToDate(value) {
  const ms = Math.round((value - 25569) * 86400000);
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, "0");
  const day = date.getUTCFullYear() + "-" + pad(date.getUTCMonth() + 1) + "-" + pad(date.getUTCDate());
  const time = pad(date.getUTCHours()) + ":" + pad(date.getUTCMinutes());
  return time === "00:00" ? day : day + " " + time;
}

/** Parse one worksheet into a dense matrix of display strings. */
function readSheet(xml, sharedStrings, dateStyles) {
  const rows = [];
  const rowPattern = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(xml)) !== null) {
    if (rows.length >= MAX_ROWS) break;
    const cells = [];
    const cellPattern = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
    let cellMatch;
    while ((cellMatch = cellPattern.exec(rowMatch[1])) !== null) {
      const attrs = cellMatch[1] ?? cellMatch[3] ?? "";
      const inner = cellMatch[2] ?? "";
      const ref = /r="([A-Z]+\d+)"/.exec(attrs);
      const column = ref ? columnIndex(ref[1]) : cells.length;
      if (column < 0 || column >= MAX_COLS) continue;
      const type = /t="([^"]+)"/.exec(attrs);
      const styleIndex = /s="(\d+)"/.exec(attrs);
      const valueMatch = /<v>([\s\S]*?)<\/v>/.exec(inner);
      const raw = valueMatch ? decodeXml(valueMatch[1]) : "";
      let text = "";
      if (type && type[1] === "s") {
        text = sharedStrings[Number(raw)] ?? "";
      } else if (type && type[1] === "inlineStr") {
        text = textRuns(inner);
      } else if (type && type[1] === "str") {
        text = raw;
      } else if (type && type[1] === "b") {
        text = raw === "1" ? "TRUE" : "FALSE";
      } else if (type && type[1] === "e") {
        text = raw;
      } else if (raw !== "") {
        const numeric = Number(raw);
        const isDate = styleIndex && dateStyles.has(Number(styleIndex[1]));
        text = isDate && Number.isFinite(numeric) ? serialToDate(numeric) : raw;
      }
      cells[column] = text;
    }
    for (let index = 0; index < cells.length; index += 1) {
      if (cells[index] === undefined) cells[index] = "";
    }
    rows.push(cells);
  }
  while (rows.length > 0 && rows[rows.length - 1].every((cell) => cell === "")) rows.pop();
  return rows;
}

/**
 * Read a workbook buffer into `{ sheets: [{ name, rows }] }`.
 *
 * @param buffer - the `.xlsx` bytes.
 * @returns sheets in workbook order, capped by {@link MAX_SHEETS}.
 */
export function readWorkbook(buffer) {
  const entries = readEntries(buffer);
  const read = (name) => {
    const entry = entries.get(name);
    return entry === undefined ? null : unzipEntry(buffer, entry).toString("utf8");
  };

  const sharedXml = read("xl/sharedStrings.xml") ?? "";
  const sharedStrings = [];
  const siPattern = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
  let siMatch;
  while ((siMatch = siPattern.exec(sharedXml)) !== null) sharedStrings.push(textRuns(siMatch[1]));

  const dateStyles = readDateStyles(read("xl/styles.xml") ?? "");

  const relsXml = read("xl/_rels/workbook.xml.rels") ?? "";
  const rels = new Map();
  const relPattern = /<Relationship\b([^>]*)\/?>/g;
  let relMatch;
  while ((relMatch = relPattern.exec(relsXml)) !== null) {
    const id = /Id="([^"]+)"/.exec(relMatch[1]);
    const target = /Target="([^"]+)"/.exec(relMatch[1]);
    if (id && target) rels.set(id[1], target[1].replace(/^\/?(xl\/)?/, "xl/"));
  }

  const workbookXml = read("xl/workbook.xml") ?? "";
  const declared = [];
  const sheetPattern = /<sheet\b([^>]*)\/?>/g;
  let sheetMatch;
  while ((sheetMatch = sheetPattern.exec(workbookXml)) !== null) {
    const name = /name="([^"]*)"/.exec(sheetMatch[1]);
    const rid = /r:id="([^"]+)"/.exec(sheetMatch[1]);
    if (name && rid) declared.push({ name: decodeXml(name[1]), target: rels.get(rid[1]) });
  }

  const sheets = [];
  for (const item of declared.slice(0, MAX_SHEETS)) {
    const path = item.target ?? `xl/worksheets/sheet${sheets.length + 1}.xml`;
    const xml = read(path);
    if (xml === null) continue;
    sheets.push({ name: item.name, rows: readSheet(xml, sharedStrings, dateStyles) });
  }
  return { sheets };
}

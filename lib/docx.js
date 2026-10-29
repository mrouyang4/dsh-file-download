/**
 * dsh-file-download — minimal DOCX/PPTX reading for the preview pane.
 *
 * Both formats are ZIPs of XML. Reading them here turns a document into a
 * structured node tree the page can style itself, which beats handing the
 * browser a PDF: the text stays selectable, it follows the page's dark theme,
 * and it costs no client-side dependency. The PDF fallback in
 * `previewResponse()` still covers anything this cannot parse.
 *
 * Fidelity is deliberately partial — headings, paragraphs, list items, tables,
 * bold/italic/underline runs, and slide text. Shapes, charts, images, and
 * animations are dropped rather than approximated.
 *
 * @module
 */
import { inflateRawSync } from "node:zlib";

/** Caps so a pathological document cannot balloon into hundreds of MB. */
const MAX_BLOCKS = 4000;
const MAX_SLIDES = 200;

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** Read one ZIP entry's uncompressed bytes. */
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

/** Pull the runs of one `<w:p>` (or `<a:p>`) as `{ text, bold, italic, underline }`. */
function readRuns(xml) {
  const runs = [];
  const pattern = /<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g;
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    const inner = match[1];
    const textParts = [];
    const textPattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g;
    let textMatch;
    while ((textMatch = textPattern.exec(inner)) !== null) {
      if (textMatch[0].startsWith("<w:tab")) textParts.push("\t");
      else if (textMatch[0].startsWith("<w:br")) textParts.push("\n");
      else textParts.push(decodeXml(textMatch[1]));
    }
    const text = textParts.join("");
    if (text === "") continue;
    const props = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(inner);
    const flags = props ? props[1] : "";
    runs.push({
      text,
      bold: /<w:b\s*\/>|<w:b\s/.test(flags),
      italic: /<w:i\s*\/>|<w:i\s/.test(flags),
      underline: /<w:u\s/.test(flags),
    });
  }
  return runs;
}

/** Heading level from a paragraph style name, or 0. */
function headingLevel(styleValue) {
  if (!styleValue) return 0;
  const match = /^(?:Heading|Überschrift|Titre)\s*(\d)/i.exec(styleValue);
  if (match) return Math.min(6, Math.max(1, Number(match[1])));
  if (/^Title$/i.test(styleValue)) return 1;
  if (/^Subtitle$/i.test(styleValue)) return 2;
  return 0;
}

/** `ListBullet` / `ListNumber` / `ListParagraph` style names imply a list item. */
function listStyle(styleValue) {
  if (!styleValue) return null;
  if (/^ListBullet/i.test(styleValue)) return "bullet";
  if (/^ListNumber/i.test(styleValue)) return "ordered";
  if (/^ListParagraph/i.test(styleValue)) return "bullet";
  return null;
}

/** Split a `<w:tbl>` run into a matrix of cell strings, honouring gridSpan. */
function readTable(tableXml) {
  const rows = [];
  const rowPattern = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(tableXml)) !== null) {
    const cells = [];
    const cellPattern = /<w:tc>([\s\S]*?)<\/w:tc>/g;
    let cellMatch;
    while ((cellMatch = cellPattern.exec(rowMatch[1])) !== null) {
      const cell = cellMatch[1];
      const paragraphs = [];
      const paragraphPattern = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
      let paragraphMatch;
      while ((paragraphMatch = paragraphPattern.exec(cell)) !== null) {
        const text = readRuns(paragraphMatch[1]).map((run) => run.text).join("");
        if (text !== "") paragraphs.push(text);
      }
      const spanMatch = /<w:gridSpan\s+w:val="(\d+)"/.exec(cell);
      const span = spanMatch ? Math.max(1, Math.min(20, Number(spanMatch[1]))) : 1;
      cells.push(paragraphs.join("\n"));
      for (let extra = 1; extra < span; extra += 1) cells.push("");
    }
    if (cells.length > 0) rows.push(cells);
    if (rows.length >= MAX_BLOCKS) break;
  }
  return rows;
}

/** Parse `word/document.xml` into preview blocks. */
function readDocxBlocks(xml) {
  const blocks = [];
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml);
  const source = body ? body[1] : xml;
  const tagPattern = /<w:tbl>/g;
  let cursor = 0;
  let match;

  const readParagraph = (paragraphXml) => {
    if (blocks.length >= MAX_BLOCKS) return;
    const runs = readRuns(paragraphXml);
    if (runs.length === 0) return;
    const styleMatch = /<w:pStyle\s+w:val="([^"]*)"/.exec(paragraphXml);
    const styleValue = styleMatch ? decodeXml(styleMatch[1]) : "";
    const level = headingLevel(styleValue);
    const numbered = listStyle(styleValue);
    if (level > 0) {
      blocks.push({ kind: "heading", level, runs });
    } else if (numbered !== null || /<w:numPr>/.test(paragraphXml)) {
      blocks.push({ kind: "list", ordered: numbered === "ordered", runs });
    } else {
      blocks.push({ kind: "paragraph", runs });
    }
  };

  // Walk the body in document order: paragraphs outside tables, then tables
  // as single blocks (their cells are read by readTable).
  while ((match = tagPattern.exec(source)) !== null) {
    const tableStart = match.index;
    // Every paragraph before this table.
    const before = source.slice(cursor, tableStart);
    const paragraphPattern = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
    let paragraphMatch;
    while ((paragraphMatch = paragraphPattern.exec(before)) !== null) readParagraph(paragraphMatch[1]);

    const tableEnd = source.indexOf("</w:tbl>", tableStart);
    const tableXml = source.slice(tableStart, tableEnd < 0 ? source.length : tableEnd + 8);
    const rows = readTable(tableXml);
    if (rows.length > 0) blocks.push({ kind: "table", rows });
    cursor = tableEnd < 0 ? source.length : tableEnd + 8;
    tagPattern.lastIndex = cursor;
  }
  const tail = source.slice(cursor);
  const paragraphPattern = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let paragraphMatch;
  while ((paragraphMatch = paragraphPattern.exec(tail)) !== null) readParagraph(paragraphMatch[1]);
  return blocks;
}

/** Order slides the way `presentation.xml` lists them. */
function slideOrder(entries, read) {
  const relsXml = read("ppt/_rels/presentation.xml.rels") ?? "";
  const rels = new Map();
  const relPattern = /<Relationship\b([^>]*)\/?>/g;
  let relMatch;
  while ((relMatch = relPattern.exec(relsXml)) !== null) {
    const id = /Id="([^"]+)"/.exec(relMatch[1]);
    const target = /Target="([^"]+)"/.exec(relMatch[1]);
    if (id && target) rels.set(id[1], target[1].replace(/^\/?(ppt\/)?/, "ppt/"));
  }
  const presentationXml = read("ppt/presentation.xml") ?? "";
  const ordered = [];
  const idPattern = /<p:sldId\b([^>]*)\/?>/g;
  let idMatch;
  while ((idMatch = idPattern.exec(presentationXml)) !== null) {
    const rid = /r:id="([^"]+)"/.exec(idMatch[1]);
    if (rid && rels.has(rid[1])) ordered.push(rels.get(rid[1]));
  }
  if (ordered.length > 0) return ordered;
  // Fall back to filename order when the manifest is missing or unusual.
  return [...entries.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]));
}

/** Parse every slide into ordered text lines. */
function readSlides(entries, read) {
  const slides = [];
  for (const path of slideOrder(entries, read).slice(0, MAX_SLIDES)) {
    const xml = read(path);
    if (xml === null) continue;
    const lines = [];
    const shapePattern = /<p:sp>([\s\S]*?)<\/p:sp>/g;
    let shapeMatch;
    while ((shapeMatch = shapePattern.exec(xml)) !== null) {
      const shape = shapeMatch[1];
      // The placeholder type tells us whether this shape is a title.
      const ph = /<p:ph\b([^>]*)\/?>/.exec(shape);
      const phType = ph ? /type="([^"]+)"/.exec(ph[1])?.[1] ?? "body" : "body";
      const paragraphs = [];
      const paraPattern = /<a:p>([\s\S]*?)<\/a:p>/g;
      let paraMatch;
      while ((paraMatch = paraPattern.exec(shape)) !== null) {
        const runs = [];
        const runPattern = /<a:r>([\s\S]*?)<\/a:r>/g;
        let runMatch;
        while ((runMatch = runPattern.exec(paraMatch[1])) !== null) {
          const text = /<a:t>([\s\S]*?)<\/a:t>/.exec(runMatch[1]);
          if (!text) continue;
          const props = /<a:rPr\b([^>]*)/.exec(runMatch[1]);
          runs.push({
            text: decodeXml(text[1]),
            bold: props ? /b="1"/.test(props[1]) : false,
            italic: props ? /i="1"/.test(props[1]) : false,
            underline: props ? /u="[^"]+"/.test(props[1]) : false,
          });
        }
        const joined = runs.map((run) => run.text).join("");
        if (joined.trim() !== "") paragraphs.push(runs);
      }
      if (paragraphs.length === 0) continue;
      const isTitle = phType === "title" || phType === "ctrTitle";
      const isSubtitle = phType === "subTitle";
      for (const runs of paragraphs) lines.push({ title: isTitle, subtitle: isSubtitle, runs });
    }
    slides.push({ index: slides.length + 1, lines });
  }
  return slides;
}

/**
 * Read a `.docx` buffer into `{ blocks }`.
 * @param buffer - the document bytes.
 */
export function readDocx(buffer) {
  const entries = readEntries(buffer);
  const read = (name) => {
    const entry = entries.get(name);
    return entry === undefined ? null : unzipEntry(buffer, entry).toString("utf8");
  };
  const xml = read("word/document.xml");
  if (xml === null) throw new Error("docx: word/document.xml missing");
  return { blocks: readDocxBlocks(xml) };
}

/**
 * Read a `.pptx` buffer into `{ slides }`.
 * @param buffer - the presentation bytes.
 */
export function readPptx(buffer) {
  const entries = readEntries(buffer);
  const read = (name) => {
    const entry = entries.get(name);
    return entry === undefined ? null : unzipEntry(buffer, entry).toString("utf8");
  };
  return { slides: readSlides(entries, read) };
}

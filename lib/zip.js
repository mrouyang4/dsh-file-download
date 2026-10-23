/**
 * dsh-file-download — streaming ZIP writer.
 *
 * A directory download must not buffer the whole tree (a workspace can hold
 * gigabytes). This module writes a ZIP incrementally with the STORE method and
 * a data descriptor per entry: the local header is emitted before the bytes
 * exist, the CRC is accumulated while streaming, and the descriptor plus the
 * central directory are written at the end. No dependency, no compression, and
 * the host's memory stays at one chunk.
 *
 * ZIP is a 32-bit format here: an entry or an archive larger than 4 GiB is
 * refused instead of silently truncated. Compressing already-compressed Office
 * and media files would buy nothing, so STORE is the right method anyway.
 */

/** Signatures and fixed sizes of the records we write. */
const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const LOCAL_HEADER_SIZE = 30;
const DESCRIPTOR_SIZE = 16;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;
const MAX_32 = 0xffffffff;

/** CRC-32 lookup table (IEEE 802.3 polynomial). */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (0xedb88320 ^ (value >>> 1)) >>> 0 : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

/** Continue one CRC-32 accumulation over a chunk. */
export function crc32(chunk, seed = 0) {
  let crc = ~seed >>> 0;
  for (let i = 0; i < chunk.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ chunk[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return ~crc >>> 0;
}

/** MS-DOS date/time pair for one modification time. */
function dosDateTime(input) {
  const date = input instanceof Date ? input : new Date(input);
  const year = Math.max(1980, date.getFullYear());
  return {
    time: ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f),
  };
}

/** UTF-8 name bytes plus the UTF-8 flag when the name is not pure ASCII. */
function nameBytes(name) {
  const bytes = Buffer.from(name, "utf8");
  return { bytes, utf8: bytes.length !== name.length };
}

/** One local file header. Sizes and CRC stay zero because a descriptor follows. */
function localHeader(name, stamp, utf8) {
  const header = Buffer.alloc(LOCAL_HEADER_SIZE);
  header.writeUInt32LE(SIG_LOCAL, 0);
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(utf8 ? 0x0808 : 0x0008, 6); // descriptor + optional UTF-8 flag
  header.writeUInt16LE(0, 8); // STORE
  header.writeUInt16LE(stamp.time, 10);
  header.writeUInt16LE(stamp.date, 12);
  header.writeUInt32LE(0, 14); // crc, filled by the descriptor
  header.writeUInt32LE(0, 18); // compressed size
  header.writeUInt32LE(0, 22); // uncompressed size
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28); // extra length
  return Buffer.concat([header, name]);
}

/** Data descriptor closing one streamed entry. */
function descriptor(crc, size) {
  const record = Buffer.alloc(DESCRIPTOR_SIZE);
  record.writeUInt32LE(SIG_DESCRIPTOR, 0);
  record.writeUInt32LE(crc, 4);
  record.writeUInt32LE(size, 8);
  record.writeUInt32LE(size, 12);
  return record;
}

/** One central-directory record for an entry whose local header offset is known. */
function centralHeader(entry) {
  const record = Buffer.alloc(CENTRAL_HEADER_SIZE);
  record.writeUInt32LE(SIG_CENTRAL, 0);
  record.writeUInt16LE(20, 4); // version made by
  record.writeUInt16LE(20, 6); // version needed
  record.writeUInt16LE(entry.utf8 ? 0x0808 : 0x0008, 8);
  record.writeUInt16LE(0, 10); // STORE
  record.writeUInt16LE(entry.stamp.time, 12);
  record.writeUInt16LE(entry.stamp.date, 14);
  record.writeUInt32LE(entry.crc, 16);
  record.writeUInt32LE(entry.size, 20);
  record.writeUInt32LE(entry.size, 24);
  record.writeUInt16LE(entry.name.length, 28);
  record.writeUInt16LE(0, 30); // extra
  record.writeUInt16LE(0, 32); // comment
  record.writeUInt16LE(0, 34); // disk start
  record.writeUInt16LE(0, 36); // internal attributes
  record.writeUInt32LE((0o100644 * 0x10000) >>> 0, 38); // external attributes: regular file 0644
  record.writeUInt32LE(entry.offset, 42);
  const head = Buffer.from(record);
  return Buffer.concat([head, entry.name]);
}

/** End-of-central-directory record. */
function endRecord(count, size, offset) {
  const record = Buffer.alloc(EOCD_SIZE);
  record.writeUInt32LE(SIG_EOCD, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(count, 8);
  record.writeUInt16LE(count, 10);
  record.writeUInt32LE(size, 12);
  record.writeUInt32LE(offset, 16);
  record.writeUInt16LE(0, 20);
  return record;
}

/**
 * Stream one directory tree as a ZIP archive.
 * @param {Array<{name: string, opened: () => import('node:stream').Readable, size: number, mtimeMs: number}>} entries
 *   Archive entries in write order; `name` is the in-archive path, `opened`
 *   opens the file stream lazily so only one file is ever open.
 * @returns {AsyncGenerator<Buffer>} archive bytes, produced incrementally.
 */
export async function* zipEntries(entries) {
  let offset = 0;
  const written = [];

  for (const entry of entries) {
    if (entry.size > MAX_32) {
      throw new Error(`文件过大，无法打包：${entry.name}`);
    }
    const { bytes, utf8 } = nameBytes(entry.name);
    const stamp = dosDateTime(entry.mtimeMs);
    const header = localHeader(bytes, stamp, utf8);
    yield header;
    offset += header.length;

    let crc = 0;
    let size = 0;
    for await (const chunk of entry.opened()) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_32) throw new Error(`文件过大，无法打包：${entry.name}`);
      crc = crc32(buffer, crc);
      yield buffer;
    }
    const tail = descriptor(crc, size);
    yield tail;
    offset += size + tail.length;

    written.push({ name: bytes, utf8, stamp, crc, size, offset: offset - size - tail.length - header.length });
  }

  const directoryStart = offset;
  let directorySize = 0;
  for (const entry of written) {
    const record = centralHeader(entry);
    directorySize += record.length;
    yield record;
  }
  yield endRecord(written.length, directorySize, directoryStart);
}

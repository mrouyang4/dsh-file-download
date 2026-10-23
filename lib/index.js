/**
 * dsh-file-download — host half.
 *
 * Gives the browser a way to work with host files: authenticated download,
 * listing, ZIP archive, upload, folder creation, and delete routes, plus a
 * self-contained file manager at `/files`.
 *
 * Everything runs behind the Web GUI's own authentication: the `/api` routes
 * are registered on the exact-Fetch registry, so only an owner Peer with a
 * valid browser cookie reaches them, and `/files` asks
 * `ctx.connection.requestRejection` the same question the host's API asks.
 *
 * Paths resolve through `realpath` and must land inside one of the configured
 * roots (home plus the process working directory by default). That check is
 * what turns "touch anything through the browser" into "touch the files this
 * machine is allowed to serve", and it is deliberately applied to symlinks
 * too, so a link pointing outside a root is refused.
 *
 * @module
 */
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { renderPage } from "./page.js";
import { zipEntries } from "./zip.js";

/** Cordis plugin name. */
export const name = "dsh-file-download";

/** Both the Fetch routes and the plain page route need the web carrier. */
export const inject = ["connection", "webServer"];

/** Exact paths the API routes occupy on the shared `/api` channel. */
const DOWNLOAD_PATH = "/api/files.download";
const LIST_PATH = "/api/files.list";
const ZIP_PATH = "/api/files.zip";
const UPLOAD_PATH = "/api/files.upload";
const MKDIR_PATH = "/api/files.mkdir";
const DELETE_PATH = "/api/files.delete";
const ROOTS_PATH = "/api/files.roots";

/** The human-facing browser page. */
const PAGE_PATH = "/files";

/** Content type per extension for the formats this deployment actually trades in. */
const MIME = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pdf": "application/pdf",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".xml": "application/xml",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".7z": "application/x-7z-compressed",
  ".log": "text/plain; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ipynb": "application/x-ipynb+json",
  ".parquet": "application/octet-stream",
};

/** RFC 5987 attribute value: everything outside the safe set is percent-encoded. */
function attrEncode(text) {
  return String(text).replace(
    /[^A-Za-z0-9!#$&+\-.^_`|~]/gu,
    (char) => {
      const bytes = Buffer.from(char, "utf8");
      let out = "";
      for (const byte of bytes) out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      return out;
    },
  );
}

/** UTF-8 filename for non-ASCII names; ASCII fallback for ancient clients. */
function disposition(kind, name) {
  const ascii = name.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/gu, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${attrEncode(name)}`;
}

/** JSON response helper for the two API routes. */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/** Resolve the configured roots into real paths, dropping ones that do not exist. */
/**
 * Directories this plugin may touch, resolved per request so a workspace added
 * in the UI becomes reachable without a restart.
 *
 * The default is the DSH workspace registry — the folders the user explicitly
 * attached to the product — never the whole home directory. An explicit
 * `roots` configuration replaces that list.
 */
function makeRoots(ctx, config) {
  const configured = Array.isArray(config.roots) && config.roots.length > 0 ? config.roots : undefined;
  return () => {
    const records = [];
    if (configured !== undefined) {
      for (const entry of configured) {
        if (typeof entry !== "string" || entry.trim() === "") continue;
        const path = resolve(entry);
        records.push({ path, name: basename(path) || path });
      }
    } else {
      let registry;
      try {
        registry = ctx.get("workspaceRegistry");
      } catch {
        registry = undefined;
      }
      let listed = [];
      try {
        listed = registry?.list?.() ?? [];
      } catch {
        listed = [];
      }
      for (const workspace of listed) {
        if (typeof workspace?.path !== "string" || workspace.path.trim() === "") continue;
        const path = resolve(workspace.path);
        const title = typeof workspace.title === "string" ? workspace.title.trim() : "";
        records.push({ path, name: title !== "" ? title : basename(path) || path });
      }
      if (records.length === 0) {
        const path = resolve(process.cwd());
        records.push({ path, name: basename(path) || path });
      }
    }
    const seen = new Set();
    return records.filter((record) => {
      if (seen.has(record.path)) return false;
      seen.add(record.path);
      return true;
    });
  };
}

/** Non-blocking existence probe. */
async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** Whether one real path sits inside a root. */
function inside(target, roots) {
  return roots.some((root) => target === root || target.startsWith(root.endsWith(sep) ? root : root + sep));
}

/**
 * Turn a user-supplied path into a real path inside a root.
 * @returns the real path, or a Response describing why it cannot be served.
 */
async function locate(raw, roots) {
  if (typeof raw !== "string" || raw.trim() === "") return { error: json({ ok: false, error: "缺少 path 参数" }, 400) };
  const target = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  let real;
  try {
    real = await realpath(target);
  } catch {
    return { error: json({ ok: false, error: `文件不存在：${raw}` }, 404) };
  }
  if (!inside(real, roots)) {
    return { error: json({ ok: false, error: "该路径不在允许下载的目录范围内" }, 403) };
  }
  return { path: real };
}

/** Parse one `Range: bytes=…` header against a known length. */
function parseRange(header, size) {
  if (typeof header !== "string") return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;
  let start;
  let end;
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Stream one file back as a browser download (or an inline preview).
 * @param request - the Fetch request the bridge handed over.
 * @param roots - directories this route may serve.
 * @returns the response carrying the bytes.
 */
async function downloadResponse(request, roots) {
  const url = new URL(request.url);
  const located = await locate(url.searchParams.get("path"), roots);
  if (located.error) return located.error;

  let info;
  try {
    info = await stat(located.path);
  } catch {
    return json({ ok: false, error: "无法读取该文件" }, 500);
  }
  if (info.isDirectory()) {
    return json({ ok: false, error: "这是一个目录，请进入目录后逐个下载" }, 400);
  }
  if (!info.isFile()) {
    return json({ ok: false, error: "不是普通文件，无法下载" }, 400);
  }

  const fileName = url.searchParams.get("name")?.trim() || basename(located.path);
  const inline = url.searchParams.get("inline") === "1";
  const type = MIME[extname(located.path).toLowerCase()] ?? "application/octet-stream";
  const headers = {
    "content-type": type,
    "content-disposition": disposition(inline ? "inline" : "attachment", fileName),
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  };

  const range = parseRange(request.headers.get("range"), info.size);
  if (range === null) {
    return new Response(null, {
      status: 416,
      headers: { ...headers, "content-range": `bytes */${info.size}` },
    });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? info.size - 1;
  headers["content-length"] = String(info.size === 0 ? 0 : end - start + 1);
  if (range) headers["content-range"] = `bytes ${start}-${end}/${info.size}`;

  if (request.method === "HEAD" || info.size === 0) {
    return new Response(null, { status: range ? 206 : 200, headers });
  }
  const stream = createReadStream(located.path, range ? { start, end } : undefined);
  return new Response(Readable.toWeb(stream), { status: range ? 206 : 200, headers });
}

/** List one directory for the browser page. */
async function listResponse(request, roots) {
  const url = new URL(request.url);
  const raw = url.searchParams.get("path") ?? roots[0];
  const located = await locate(raw, roots);
  if (located.error) return located.error;

  // Async on purpose: one directory on this machine lives behind a file
  // provider that can stall for minutes, and a blocking readdir there would
  // freeze every other request the host is serving.
  let info;
  try {
    info = await stat(located.path);
  } catch {
    return json({ ok: false, error: "无法读取该目录" }, 500);
  }
  if (!info.isDirectory()) return json({ ok: false, error: "不是目录" }, 400);

  let entries;
  try {
    entries = await readdir(located.path, { withFileTypes: true });
  } catch (error) {
    return json({ ok: false, error: `无法列出目录：${String(error?.message ?? error)}` }, 500);
  }

  const stats = await Promise.all(
    entries.map(async (entry) => {
      const full = resolve(located.path, entry.name);
      try {
        return { full, info: await stat(full) };
      } catch {
        return { full, info: undefined };
      }
    }),
  );

  const rows = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const { full, info: child } = stats[i];
    let kind = entry.isDirectory() ? "dir" : "file";
    let size = 0;
    let mtimeMs = 0;
    if (child !== undefined) {
      if (child.isDirectory()) kind = "dir";
      else if (child.isFile()) kind = "file";
      else kind = "other";
      size = kind === "file" ? child.size : 0;
      mtimeMs = child.mtimeMs;
    } else if (kind === "other") {
      continue;
    }
    rows.push({ name: entry.name, kind, size, mtimeMs, path: full });
  }
  rows.sort((a, b) => {
    if (a.kind === "dir" && b.kind !== "dir") return -1;
    if (b.kind === "dir" && a.kind !== "dir") return 1;
    return a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true });
  });

  const parent = located.path === "/" ? undefined : resolve(located.path, "..");
  return json({
    ok: true,
    path: located.path,
    parent: parent && inside(parent, roots) ? parent : undefined,
    roots,
    entries: rows,
  });
}

/** Archive noise macOS leaves behind; nobody wants it inside a download. */
function isNoise(name) {
  return name === ".DS_Store" || name.startsWith("._");
}

/** Walk one directory tree into archive entries, skipping symlinks and noise. */
async function collectTree(root, limit) {
  const files = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue; // never follow links out of the root or into loops
      if (isNoise(entry.name)) continue;
      const full = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        if (files.length >= limit) throw new Error(`目录内文件超过 ${limit} 个，请分批下载`);
        const info = await stat(full);
        files.push({
          absolute: full,
          name: relative(root, full).split(sep).join("/"),
          size: info.size,
          mtimeMs: info.mtimeMs,
        });
      }
    }
  };
  await walk(root);
  files.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true }));
  return files;
}

/**
 * Stream one directory as a ZIP archive.
 * @param request - the Fetch request the bridge handed over.
 * @param roots - directories this route may serve.
 * @returns the response carrying the archive bytes.
 */
async function zipResponse(request, roots) {
  const url = new URL(request.url);
  const located = await locate(url.searchParams.get("path"), roots);
  if (located.error) return located.error;

  let info;
  try {
    info = await stat(located.path);
  } catch {
    return json({ ok: false, error: "无法读取该目录" }, 500);
  }
  if (!info.isDirectory()) return json({ ok: false, error: "只能打包目录，单个文件请直接下载" }, 400);

  let files;
  try {
    files = await collectTree(located.path, 5000);
  } catch (error) {
    return json({ ok: false, error: String(error?.message ?? error) }, 400);
  }
  if (files.length === 0) return json({ ok: false, error: "目录为空，没有可打包的文件" }, 400);

  const archiveName = `${basename(located.path) || "files"}.zip`;
  const headers = {
    "content-type": "application/zip",
    "content-disposition": disposition("attachment", archiveName),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  };
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });

  const entries = files.map((file) => ({
    name: file.name,
    size: file.size,
    mtimeMs: file.mtimeMs,
    opened: () => createReadStream(file.absolute),
  }));
  const body = Readable.toWeb(Readable.from(zipEntries(entries)));
  return new Response(body, { status: 200, headers });
}

/**
 * A single path segment, never a path. Uploads and new folders may only name
 * one entry, so a crafted name cannot walk out of the directory it targets.
 */
function safeSegment(raw) {
  if (typeof raw !== "string") return undefined;
  const name = raw.trim();
  if (name === "" || name === "." || name === "..") return undefined;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return undefined;
  if (name.length > 255) return undefined;
  return name;
}

/** Stream one request body to `target` through a temporary file, atomically. */
async function receiveUpload(request, target) {
  if (request.body === null) throw new Error("请求没有文件内容");
  const partial = `${target}.part-${randomUUID().slice(0, 8)}`;
  try {
    await pipeline(Readable.fromWeb(request.body), createWriteStream(partial));
    await rename(partial, target);
  } catch (error) {
    try {
      await rm(partial, { force: true });
    } catch {
      /* leaving a stray part file is better than masking the real error */
    }
    throw error;
  }
}

/** Upload one file into a directory. */
async function uploadResponse(request, roots) {
  if (request.method !== "POST") return json({ ok: false, error: "请用 POST 上传" }, 405);
  const url = new URL(request.url);
  const dir = await locate(url.searchParams.get("path"), roots);
  if (dir.error) return dir.error;

  let info;
  try {
    info = await stat(dir.path);
  } catch {
    return json({ ok: false, error: "无法读取目标目录" }, 500);
  }
  if (!info.isDirectory()) return json({ ok: false, error: "目标不是目录" }, 400);

  const name = safeSegment(url.searchParams.get("name"));
  if (name === undefined) return json({ ok: false, error: "文件名不合法" }, 400);
  const target = resolve(dir.path, name);
  if (!inside(target, roots)) return json({ ok: false, error: "目标不在允许的目录范围内" }, 403);
  if ((await pathExists(target)) && url.searchParams.get("overwrite") !== "1") {
    return json({ ok: false, error: `已存在同名文件：${name}` }, 409);
  }
  try {
    await receiveUpload(request, target);
  } catch (error) {
    return json({ ok: false, error: `上传失败：${String(error?.message ?? error)}` }, 500);
  }
  return json({ ok: true, path: target, name });
}

/** Create one folder inside a directory. */
async function mkdirResponse(request, roots) {
  if (request.method !== "POST") return json({ ok: false, error: "请用 POST" }, 405);
  const url = new URL(request.url);
  const parent = await locate(url.searchParams.get("path"), roots);
  if (parent.error) return parent.error;
  const name = safeSegment(url.searchParams.get("name"));
  if (name === undefined) return json({ ok: false, error: "文件夹名不合法" }, 400);
  const target = resolve(parent.path, name);
  if (!inside(target, roots)) return json({ ok: false, error: "目标不在允许的目录范围内" }, 403);
  if (await pathExists(target)) return json({ ok: false, error: `已存在同名条目：${name}` }, 409);
  try {
    await mkdir(target);
  } catch (error) {
    return json({ ok: false, error: `新建失败：${String(error?.message ?? error)}` }, 500);
  }
  return json({ ok: true, path: target, name });
}

/** Permanently delete one file or directory tree. */
async function deleteResponse(request, roots) {
  if (request.method !== "POST") return json({ ok: false, error: "请用 POST" }, 405);
  const url = new URL(request.url);
  const target = await locate(url.searchParams.get("path"), roots);
  if (target.error) return target.error;
  if (roots.includes(target.path)) return json({ ok: false, error: "不能删除允许访问的根目录本身" }, 403);
  const name = basename(target.path);
  try {
    await rm(target.path, { recursive: true, force: true });
  } catch (error) {
    return json({ ok: false, error: `删除失败：${String(error?.message ?? error)}` }, 500);
  }
  return json({ ok: true, name, permanent: true });
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ roots?: string[] }} [config]
 */
export function apply(ctx, config = {}) {
  const rootsOf = makeRoots(ctx, config);
  const rootPaths = () => rootsOf().map((record) => record.path);
  const connection = ctx.connection;

  ctx.effect(
    () => {
      const disposeDownload = connection.fetch.register({
        path: DOWNLOAD_PATH,
        methods: ["GET", "HEAD"],
        requestBody: "buffered",
        fetch: (request) => downloadResponse(request, rootPaths()),
      });
      const disposeList = connection.fetch.register({
        path: LIST_PATH,
        methods: ["GET", "HEAD"],
        requestBody: "buffered",
        fetch: (request) =>
          request.method === "HEAD"
            ? new Response(null, { status: 200 })
            : listResponse(request, rootPaths()),
      });
      const disposeZip = connection.fetch.register({
        path: ZIP_PATH,
        methods: ["GET", "HEAD"],
        requestBody: "buffered",
        fetch: (request) => zipResponse(request, rootPaths()),
      });
      const disposeUpload = connection.fetch.register({
        path: UPLOAD_PATH,
        methods: ["POST"],
        // Raw bytes with backpressure: the body is the file, not JSON.
        requestBody: "streaming",
        fetch: (request) => uploadResponse(request, rootPaths()),
      });
      const disposeMkdir = connection.fetch.register({
        path: MKDIR_PATH,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: (request) => Promise.resolve(mkdirResponse(request, rootPaths())),
      });
      const disposeRoots = connection.fetch.register({
        path: ROOTS_PATH,
        methods: ["GET", "HEAD"],
        requestBody: "buffered",
        fetch: () => Promise.resolve(json({ ok: true, roots: rootsOf() })),
      });
      const disposeDelete = connection.fetch.register({
        path: DELETE_PATH,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: (request) => Promise.resolve(deleteResponse(request, rootPaths())),
      });
      return async () => {
        await disposeDownload();
        await disposeList();
        await disposeZip();
        await disposeUpload();
        await disposeMkdir();
        await disposeDelete();
        await disposeRoots();
      };
    },
    "dsh-file-download: api routes",
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: PAGE_PATH,
        handler: (request, response) => {
          const rejection = typeof connection?.requestRejection === "function"
            ? connection.requestRejection(request)
            : undefined;
          if (rejection !== undefined) {
            response.writeHead(rejection === 401 ? 401 : 403, {
              "content-type": "text/plain; charset=utf-8",
              "cache-control": "no-store",
            });
            response.end(
              rejection === 401
                ? "需要先登录：请用启动时打印的带 token 地址打开一次 DSH Web。"
                : "请求来源不受信任。",
            );
            return;
          }
          if (request.method !== "GET" && request.method !== "HEAD") {
            response.writeHead(405, { allow: "GET, HEAD" });
            response.end();
            return;
          }
          const records = rootsOf();
          const paths = records.map((record) => record.path);
          let home = paths[0];
          const cwd = resolve(process.cwd());
          if (paths.includes(cwd)) home = cwd;
          const html = renderPage({ roots: records, start: home });
          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-length": String(Buffer.byteLength(html)),
            "cache-control": "no-store",
          });
          response.end(html);
        },
      }),
    "dsh-file-download: browser page",
  );
}

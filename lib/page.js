/**
 * dsh-file-download — the file manager page.
 *
 * One self-contained HTML document: no build step, no external assets. It talks
 * to the same-origin `/api/files.*` routes the host half registers, so it
 * inherits the browser cookie authentication the rest of the Web GUI uses.
 *
 * The page has exactly two views. It opens on the workspace roster — the
 * directories the DSH workspace registry knows about — because those are the
 * only places this plugin may touch. Entering one workspace switches to the
 * directory view, whose breadcrumbs start at the workspace name and never climb
 * above it.
 */

/**
 * Render the manager.
 * @param {object} options
 * @param {Array<{path: string, name: string}>} options.roots - Workspaces this page may browse.
 * @param {string} [options.start] - Optional deep-linked directory to open.
 * @returns {string} the complete HTML document.
 */
const PAGE_SCRIPT = String.raw`
const el = (id) => document.getElementById(id);
const state = { roots: ROOTS, rootPath: null, path: null, entries: [], query: "" };

const fmtSize = (n) => {
  if (!Number.isFinite(n)) return "";
  if (n < 1024) return n + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + " " + units[i];
};
const fmtTime = (ms) => {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
};
const downloadUrl = (path, inline) =>
  "/api/files.download?path=" + encodeURIComponent(path) + (inline ? "&inline=1" : "");
const zipUrl = (path) => "/api/files.zip?path=" + encodeURIComponent(path);

const toast = (text) => {
  const node = el("toast");
  node.textContent = text;
  node.classList.add("on");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("on"), 2000);
};

const icon = (kind) => {
  const open = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">';
  if (kind === "dir") return open + '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>';
  if (kind === "up") return open + '<path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  return open + '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/></svg>';
};

/* ------------------------------------------------------------------ *
 * Workspace roster: this is the only entry point of the manager.
 * ------------------------------------------------------------------ */

function rootFor(path) {
  let best = null;
  for (const root of state.roots) {
    const base = root.path.replace(/\/+$/, "");
    if (path === base || path.startsWith(base + "/")) {
      if (!best || base.length > best.path.replace(/\/+$/, "").length) best = root;
    }
  }
  return best;
}

function renderRoster() {
  const host = el("roster-list");
  host.textContent = "";
  if (state.roots.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "还没有工作区。在 DSH 里新建一个工作区后，这里会自动出现。";
    host.append(empty);
    return;
  }
  for (const root of state.roots) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "workspace-row";
    const glyph = document.createElement("span");
    glyph.className = "workspace-icon";
    glyph.innerHTML = icon("dir");
    const body = document.createElement("span");
    body.className = "workspace-body";
    const name = document.createElement("span");
    name.className = "workspace-name";
    name.textContent = root.name;
    const path = document.createElement("span");
    path.className = "workspace-path";
    path.textContent = root.path;
    body.append(name, path);
    const go = document.createElement("span");
    go.className = "workspace-go";
    go.textContent = "进入 →";
    row.append(glyph, body, go);
    row.addEventListener("click", () => {
      location.hash = encodeURIComponent(root.path);
    });
    host.append(row);
  }
}

function showRoster() {
  el("browser").hidden = true;
  el("roster").hidden = false;
  state.path = null;
  state.rootPath = null;
}

function showBrowser() {
  el("roster").hidden = true;
  el("browser").hidden = false;
}

/* ------------------------------------------------------------------ *
 * Breadcrumbs: the workspace is the first crumb, never the host path.
 * ------------------------------------------------------------------ */

function renderCrumbs() {
  const host = el("crumbs");
  host.textContent = "";
  const root = rootFor(state.path);
  if (!root) {
    host.textContent = state.path;
    return;
  }
  const base = root.path.replace(/\/+$/, "");
  const rootLink = document.createElement("a");
  rootLink.textContent = root.name;
  rootLink.href = "#" + encodeURIComponent(base);
  rootLink.title = "回到「" + root.name + "」根目录";
  host.append(rootLink);

  const rest = state.path === base ? [] : state.path.slice(base.length).split("/").filter(Boolean);
  rest.forEach((segment, index) => {
    const sep = document.createElement("span");
    sep.className = "sep";
    sep.textContent = "/";
    host.append(sep);
    const isLast = index === rest.length - 1;
    if (isLast) {
      const here = document.createElement("span");
      here.className = "here";
      here.textContent = segment;
      host.append(here);
      return;
    }
    const link = document.createElement("a");
    link.textContent = segment;
    link.href = "#" + encodeURIComponent(base + "/" + rest.slice(0, index + 1).join("/"));
    host.append(link);
  });

  el("up").disabled = state.path === base;
}

/* ------------------------------------------------------------------ *
 * Directory rows
 * ------------------------------------------------------------------ */

function renderRows() {
  const body = el("rows");
  body.textContent = "";
  const q = state.query.trim().toLowerCase();
  const list = state.entries.filter((entry) => !q || entry.name.toLowerCase().includes(q));
  if (list.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.className = "empty";
    td.textContent = q ? "没有匹配「" + state.query + "」的文件" : "空目录";
    tr.append(td);
    body.append(tr);
    return;
  }
  for (const entry of list) {
    const tr = document.createElement("tr");
    if (entry.kind === "dir") tr.className = "entry-dir";

    const nameCell = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.className = "name";
    const glyph = document.createElement("span");
    glyph.innerHTML = icon(entry.kind);
    const label = document.createElement("span");
    label.className = "txt";
    label.textContent = entry.name;
    label.title = entry.name;
    wrap.append(glyph, label);
    nameCell.append(wrap);

    const sizeCell = document.createElement("td");
    sizeCell.className = "size";
    sizeCell.textContent = entry.kind === "dir" ? "—" : fmtSize(entry.size);

    const timeCell = document.createElement("td");
    timeCell.className = "mtime";
    timeCell.textContent = fmtTime(entry.mtimeMs);

    const actions = document.createElement("td");
    actions.className = "actions";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "删除";
    remove.title = "永久删除（不可恢复）";
    remove.addEventListener("click", () => void removeEntry(entry));
    if (entry.kind === "dir") {
      const open = document.createElement("a");
      open.className = "btn";
      open.textContent = "打开";
      open.href = "#" + encodeURIComponent(entry.path);
      const zip = document.createElement("a");
      zip.className = "btn";
      zip.textContent = "打包";
      zip.title = "把整个目录打成 zip 下载";
      zip.href = zipUrl(entry.path);
      zip.setAttribute("download", "");
      actions.append(open, zip, remove);
    } else {
      const dl = document.createElement("a");
      dl.className = "btn";
      dl.textContent = "下载";
      dl.href = downloadUrl(entry.path);
      dl.setAttribute("download", "");
      const copy = document.createElement("button");
      copy.type = "button";
      copy.textContent = "复制链接";
      copy.addEventListener("click", async () => {
        const absolute = new URL(downloadUrl(entry.path), location.origin).href;
        try {
          await navigator.clipboard.writeText(absolute);
          toast("已复制下载链接");
        } catch {
          toast(absolute);
        }
      });
      actions.append(dl, copy, remove);
    }

    tr.append(nameCell, sizeCell, timeCell, actions);
    body.append(tr);
  }
}

/* ------------------------------------------------------------------ *
 * Dialogs
 * ------------------------------------------------------------------ */

const modalEl = el("modal");
let settle = null;

function closeModal(value) {
  modalEl.hidden = true;
  const done = settle;
  settle = null;
  if (done) done(value);
}

function openModal({ title, body, input, okLabel, danger }) {
  el("modal-title").textContent = title;
  el("modal-body").textContent = body;
  let field = null;
  if (input) {
    field = document.createElement("input");
    field.value = input.value || "";
    field.placeholder = input.placeholder || "";
    field.spellcheck = false;
    el("modal-body").append(field);
  }
  const ok = el("modal-ok");
  ok.textContent = okLabel;
  ok.className = "primary";
  ok.style.background = danger ? "var(--danger)" : "";
  ok.style.borderColor = danger ? "var(--danger)" : "";
  modalEl.hidden = false;
  if (field) setTimeout(() => { field.focus(); field.select(); }, 30);
  return new Promise((resolve) => {
    settle = (value) => resolve(field ? (typeof value === "string" ? value : null) : value === true);
  });
}

const askName = (title, body, value) =>
  openModal({ title, body, input: { value, placeholder: "名称" }, okLabel: "创建" });

const askConfirm = (title, body) => openModal({ title, body, okLabel: "永久删除", danger: true });

el("modal-cancel").addEventListener("click", () => closeModal(null));
el("modal-ok").addEventListener("click", () => {
  const field = el("modal-body").querySelector("input");
  closeModal(field ? field.value : true);
});
modalEl.addEventListener("click", (event) => {
  if (event.target === modalEl) closeModal(null);
});
document.addEventListener("keydown", (event) => {
  if (modalEl.hidden) return;
  const field = el("modal-body").querySelector("input");
  if (event.key === "Escape") closeModal(null);
  if (event.key === "Enter") closeModal(field ? field.value : true);
});

/* ------------------------------------------------------------------ *
 * Host calls
 * ------------------------------------------------------------------ */

async function postJson(url, init) {
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store", ...init });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.ok !== true) {
    throw new Error((payload && payload.error) || "HTTP " + response.status);
  }
  return payload;
}

async function removeEntry(entry) {
  const confirmed = await askConfirm(
    "永久删除「" + entry.name + "」？",
    entry.kind === "dir" ? "整个文件夹及其内容会被立即删除，无法恢复。" : "文件会被立即删除，无法恢复。",
  );
  if (!confirmed) return;
  try {
    await postJson("/api/files.delete?path=" + encodeURIComponent(entry.path), { method: "POST" });
    toast("已删除 " + entry.name);
    void load(state.path);
  } catch (error) {
    toast(String((error && error.message) || error));
  }
}

async function uploadFiles(files) {
  if (!files || files.length === 0) return;
  let done = 0;
  for (const file of files) {
    toast("上传 " + file.name + "（" + fmtSize(file.size) + "）…");
    const endpoint = (overwrite) =>
      "/api/files.upload?path=" + encodeURIComponent(state.path) +
      "&name=" + encodeURIComponent(file.name) + (overwrite ? "&overwrite=1" : "");
    try {
      await postJson(endpoint(false), { method: "POST", body: file });
      done += 1;
    } catch (error) {
      const message = String((error && error.message) || error);
      if (message.indexOf("同名") >= 0) {
        const overwrite = await openModal({
          title: "覆盖「" + file.name + "」？",
          body: "当前目录已有同名文件，继续会替换它。",
          okLabel: "覆盖",
          danger: true,
        });
        if (overwrite) {
          try {
            await postJson(endpoint(true), { method: "POST", body: file });
            done += 1;
          } catch (inner) {
            toast(String((inner && inner.message) || inner));
          }
        }
        continue;
      }
      toast(message);
      return;
    }
  }
  toast("已上传 " + done + " 个文件");
  void load(state.path);
}

async function makeFolder() {
  const name = await askName("新建文件夹", "将在 " + (state.path || "") + " 下创建", "");
  if (!name || name.trim() === "") return;
  try {
    await postJson(
      "/api/files.mkdir?path=" + encodeURIComponent(state.path) + "&name=" + encodeURIComponent(name.trim()),
      { method: "POST" },
    );
    toast("已创建 " + name.trim());
    void load(state.path);
  } catch (error) {
    toast(String((error && error.message) || error));
  }
}

/* ------------------------------------------------------------------ *
 * Navigation
 * ------------------------------------------------------------------ */

async function load(path) {
  const root = rootFor(path);
  if (!root) {
    showRoster();
    return;
  }
  showBrowser();
  el("loading").hidden = false;
  el("loading").textContent = "读取中…";
  el("error").hidden = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch("/api/files.list?path=" + encodeURIComponent(path), {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.ok !== true) {
      throw new Error((payload && payload.error) || "HTTP " + response.status);
    }
    state.path = payload.path;
    state.rootPath = root.path;
    state.entries = payload.entries;
    state.query = "";
    el("search").value = "";
    const desired = "#" + encodeURIComponent(state.path);
    if (location.hash !== desired) location.hash = encodeURIComponent(state.path);
    renderCrumbs();
    renderRows();
  } catch (error) {
    el("error").hidden = false;
    el("error").textContent =
      error && error.name === "AbortError"
        ? "目录响应超时（20 秒），这个目录可能在同步云端文件，稍后重试或换一个工作区"
        : "无法列出目录：" + String((error && error.message) || error);
    el("rows").textContent = "";
  } finally {
    clearTimeout(timer);
    el("loading").hidden = true;
  }
}

function currentTarget() {
  const raw = decodeURIComponent(location.hash.replace(/^#/, ""));
  return raw || null;
}

function route() {
  const target = currentTarget();
  if (!target) {
    showRoster();
    return;
  }
  void load(target);
}

async function refreshRoots() {
  try {
    const response = await fetch("/api/files.roots", { cache: "no-store", credentials: "same-origin" });
    const payload = await response.json().catch(() => null);
    if (response.ok && payload && payload.ok === true && Array.isArray(payload.roots)) {
      state.roots = payload.roots;
    }
  } catch {
    /* keep the boot-time list */
  }
  renderRoster();
}

/* ------------------------------------------------------------------ *
 * Toolbar wiring
 * ------------------------------------------------------------------ */

el("up").addEventListener("click", () => {
  const root = rootFor(state.path);
  if (!root) return;
  const base = root.path.replace(/\/+$/, "");
  if (state.path === base) return;
  const parent = state.path.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
  location.hash = encodeURIComponent(parent);
});
el("back").addEventListener("click", () => {
  history.replaceState(null, "", location.pathname + location.search);
  void refreshRoots();
  showRoster();
});
el("refresh").addEventListener("click", () => void load(state.path));
el("reload-roots").addEventListener("click", () => void refreshRoots());
el("search").addEventListener("input", (event) => {
  state.query = event.target.value;
  renderRows();
});
el("upload").addEventListener("click", () => el("picker").click());
el("picker").addEventListener("change", (event) => {
  const files = [...(event.target.files || [])];
  event.target.value = "";
  void uploadFiles(files);
});
el("mkdir").addEventListener("click", () => void makeFolder());
el("zip").addEventListener("click", () => {
  toast("正在打包当前目录…");
  const link = document.createElement("a");
  link.href = zipUrl(state.path);
  link.setAttribute("download", "");
  document.body.append(link);
  link.click();
  link.remove();
});
document.addEventListener("dragover", (event) => {
  if (!event.dataTransfer || !event.dataTransfer.types || event.dataTransfer.types.indexOf("Files") < 0) return;
  if (el("browser").hidden) return;
  event.preventDefault();
  el("browser-card").classList.add("drop");
});
document.addEventListener("dragleave", (event) => {
  if (event.relatedTarget) return;
  el("browser-card").classList.remove("drop");
});
document.addEventListener("drop", (event) => {
  if (!event.dataTransfer || !event.dataTransfer.files || event.dataTransfer.files.length === 0) return;
  if (el("browser").hidden) return;
  event.preventDefault();
  el("browser-card").classList.remove("drop");
  void uploadFiles([...event.dataTransfer.files]);
});
window.addEventListener("hashchange", route);

renderRoster();
route();

`;

export function renderPage({ roots, start }) {
  const rootsJson = JSON.stringify(roots);
  const startJson = JSON.stringify(typeof start === "string" ? start : "");
  const css = `
:root {
  --bg: #f7f8fa; --panel: #ffffff; --ink: #14161a; --muted: #6b7280; --line: #e5e7eb;
  --accent: #2563eb; --accent-soft: #eff4ff; --row-hover: #f3f6ff; --danger: #c0392b;
  --radius: 10px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115; --panel: #161a20; --ink: #e6e8eb; --muted: #9aa1ac; --line: #262b33;
    --accent: #6ea0ff; --accent-soft: #182234; --row-hover: #1b2129; --danger: #ff7a6b;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  background: var(--bg); color: var(--ink); font: 14px/1.5 -apple-system, BlinkMacSystemFont,
  "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 1040px; margin: 0 auto; padding: 28px 20px 64px; }
header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 4px; }
h1 { font-size: 20px; margin: 0; letter-spacing: .2px; }
.sub { color: var(--muted); font-size: 12.5px; }
.card {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  margin-top: 18px; overflow: hidden;
}
.bar { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
button, .btn {
  font: inherit; color: inherit; background: transparent; border: 1px solid var(--line);
  border-radius: 8px; padding: 5px 10px; cursor: pointer; text-decoration: none; line-height: 1.4;
}
button:hover, .btn:hover { background: var(--accent-soft); border-color: var(--accent); }
button:disabled { opacity: .42; cursor: default; }
button:disabled:hover { background: transparent; border-color: var(--line); }
.crumbs { display: flex; align-items: center; gap: 2px; flex: 1 1 320px; min-width: 0; flex-wrap: wrap; }
.crumbs a { color: var(--accent); text-decoration: none; padding: 2px 4px; border-radius: 6px; }
.crumbs a:hover { background: var(--accent-soft); }
.crumbs .sep { color: var(--muted); }
.crumbs .here { color: var(--ink); font-weight: 600; padding: 2px 4px; }
input[type="search"] {
  font: inherit; color: inherit; background: transparent; border: 1px solid var(--line);
  border-radius: 8px; padding: 5px 10px; width: 200px; outline: none;
}
input[type="search"]:focus { border-color: var(--accent); }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); }
th { font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover { background: var(--row-hover); }
.name { display: flex; align-items: center; gap: 8px; min-width: 0; }
.name .txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.icon { flex: none; width: 18px; height: 18px; opacity: .85; }
.size, .mtime { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; font-size: 12.5px; }
.actions { text-align: right; white-space: nowrap; }
.actions .btn { padding: 3px 9px; font-size: 12.5px; }
.actions .btn + .btn { margin-left: 6px; }
.entry-dir .txt { font-weight: 600; }
.empty, .loading, .error { padding: 28px 12px; text-align: center; color: var(--muted); }
.error { color: var(--danger); }
.foot { margin-top: 14px; color: var(--muted); font-size: 12px; display: flex; gap: 14px; flex-wrap: wrap; }
.foot code { background: var(--accent-soft); padding: 1px 5px; border-radius: 5px; color: var(--ink); }
.toast {
  position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
  background: #111827; color: #fff; padding: 8px 14px; border-radius: 8px; font-size: 13px;
  opacity: 0; transition: opacity .18s ease; pointer-events: none; z-index: 10;
}
.toast.on { opacity: 1; }
.roots { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
.roots .btn { font-size: 12.5px; }
button.primary, .btn.primary {
  background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600;
}
button.primary:hover { background: color-mix(in srgb, var(--accent) 88%, black); border-color: transparent; }
button.danger { color: var(--danger); }
button.danger:hover { background: color-mix(in srgb, var(--danger) 12%, transparent); border-color: var(--danger); }
.card.drop { outline: 2px dashed var(--accent); outline-offset: -6px; }
.modal {
  position: fixed; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, .38); padding: 24px;
}
.modal[hidden] { display: none; }
.modal-card {
  width: min(420px, 100%); background: var(--panel); color: var(--ink); border-radius: 14px;
  border: 1px solid var(--line); box-shadow: 0 18px 60px rgba(0,0,0,.28); padding: 20px;
}
.modal-title { font-size: 16px; font-weight: 650; margin-bottom: 8px; }
.modal-body { color: var(--muted); font-size: 13.5px; line-height: 1.6; overflow-wrap: anywhere; }
.modal-body input {
  font: inherit; color: inherit; width: 100%; margin-top: 10px; padding: 8px 10px;
  border: 1px solid var(--line); border-radius: 8px; background: transparent; outline: none;
}
.modal-body input:focus { border-color: var(--accent); }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }

.workspace-row {
  display: flex; align-items: center; gap: 12px; width: 100%; text-align: left;
  padding: 14px 16px; border: 0; border-bottom: 1px solid var(--line);
  background: transparent; cursor: pointer; font: inherit; color: inherit;
}
.workspace-row:last-child { border-bottom: none; }
.workspace-row:hover { background: var(--row-hover); }
.workspace-icon { display: flex; color: var(--accent); }
.workspace-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.workspace-name { font-weight: 650; }
.workspace-path { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workspace-go { color: var(--accent); font-size: 12.5px; white-space: nowrap; }
@media (max-width: 640px) {
  .size, .mtime { display: none; }
  .wrap { padding: 18px 12px 48px; }
}
`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>文件管理 · DSH</title>
<style>${css}</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>文件管理</h1>
    <span class="sub">先选工作区，再浏览、上传、下载、新建、删除</span>
  </header>

  <section id="roster" hidden>
    <div class="card">
      <div class="bar">
        <div class="crumbs"><span class="here">工作区</span></div>
        <button id="reload-roots" type="button" title="重新读取工作区列表">刷新</button>
      </div>
      <div id="roster-list"></div>
    </div>
    <div class="foot">
      <span>只列出 DSH 的工作区目录，看不到工作区以外的路径</span>
      <span>新增工作区后会自动出现在这里</span>
    </div>
  </section>

  <section id="browser" hidden>
    <div class="card" id="browser-card">
      <div class="bar">
        <button id="back" type="button" title="回到工作区列表">← 工作区</button>
        <button id="up" type="button" title="上一级">↑ 上一级</button>
        <div class="crumbs" id="crumbs"></div>
        <button id="upload" type="button" class="primary" title="上传文件到当前目录">上传文件</button>
        <button id="mkdir" type="button" title="在当前目录新建文件夹">新建文件夹</button>
        <button id="zip" type="button" title="把当前目录打成 zip 下载">打包当前目录</button>
        <button id="refresh" type="button" title="刷新">刷新</button>
        <input id="search" type="search" placeholder="筛选当前目录…" aria-label="筛选">
        <input id="picker" type="file" multiple hidden>
      </div>
      <table>
        <thead>
          <tr><th>名称</th><th class="size">大小</th><th class="mtime">修改时间</th><th class="actions">操作</th></tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
      <div id="loading" class="loading" hidden>读取中…</div>
      <div id="error" class="error" hidden></div>
    </div>
    <div class="foot">
      <span>路径从工作区开始，不会显示工作区以外的地址</span>
      <span>删除是永久删除，执行前会二次确认</span>
      <span>仅限已登录访问</span>
    </div>
  </section>
</div>
<div class="toast" id="toast"></div>
<div class="modal" id="modal" hidden>
  <div class="modal-card" role="dialog" aria-modal="true">
    <div class="modal-title" id="modal-title"></div>
    <div class="modal-body" id="modal-body"></div>
    <div class="modal-actions">
      <button type="button" id="modal-cancel">取消</button>
      <button type="button" id="modal-ok" class="primary">确定</button>
    </div>
  </div>
</div>
<script>
const ROOTS = ${rootsJson};
const START_PATH = ${startJson};
${PAGE_SCRIPT}
</script>
</body>
</html>`;
}

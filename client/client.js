window.__ModuleLoader__.load({
  id: "dsh-file-download",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const react = require("react");

    const PANEL_ID = "dsh-file-download";
    const CARD_MARK = "data-dsh-download-button";
    const DIRECT_MARK = "data-dsh-download-direct";

    /* ------------------------------------------------------------------ *
     * Shared download helpers
     * ------------------------------------------------------------------ */

    const downloadHref = (path) => "/api/files.download?path=" + encodeURIComponent(path);

    /**
     * Hand one URL to the browser's download manager without navigating the app.
     * An <a download> click downloads in place: no route change, no history entry,
     * so the conversation stays exactly where the reader left it.
     */
    function forceDownload(href) {
      const link = document.createElement("a");
      link.href = href;
      link.setAttribute("download", "");
      // Our own capture-phase trap must not see this synthetic click, or it
      // would call forceDownload again and recurse until the stack dies.
      link.setAttribute(DIRECT_MARK, "");
      link.rel = "noopener";
      link.style.display = "none";
      document.body.append(link);
      link.click();
      link.remove();
    }

    function downloadGlyph() {
      return (
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M12 3v11"></path><path d="m7.5 10 4.5 4.5 4.5-4.5"></path>' +
        '<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"></path></svg>'
      );
    }

    /* ------------------------------------------------------------------ *
     * 1. Sidebar panel: the browser page, mounted in the main column
     * ------------------------------------------------------------------ */

    function FileBrowserPanel() {
      const ref = react.useRef(null);
      react.useEffect(() => {
        const node = ref.current;
        if (!node) return undefined;
        const fit = () => {
          const parent = node.parentElement;
          const column = node.closest('[class*="centerCol"]');
          const height =
            (parent && parent.clientHeight) ||
            (column && column.clientHeight) ||
            globalThis.innerHeight;
          node.style.height = (height || 0) + "px";
        };
        fit();
        const observer = new ResizeObserver(fit);
        const parent = node.parentElement;
        if (parent) observer.observe(parent);
        globalThis.addEventListener("resize", fit);
        return () => {
          observer.disconnect();
          globalThis.removeEventListener("resize", fit);
        };
      }, []);
      return react.createElement("iframe", {
        ref,
        src: "/files",
        title: "文件管理",
        style: {
          width: "100%",
          border: "0",
          display: "block",
          background: "transparent",
          colorScheme: "normal",
        },
      });
    }

    function FileBrowserIcon({ size }) {
      return react.createElement(
        "svg",
        {
          width: size ?? 16,
          height: size ?? 16,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
        },
        react.createElement("path", {
          d: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
        }),
        react.createElement("path", { d: "M12 11v5" }),
        react.createElement("path", { d: "m9.8 14 2.2 2.2L14.2 14" }),
      );
    }

    /* ------------------------------------------------------------------ *
     * 2. Deliverable card: a download button beside preview / more
     * ------------------------------------------------------------------ */

    /**
     * Add one download button to every presented-file card that lacks it.
     * The host already puts the absolute path in the preview button's title, so
     * the card itself carries everything needed — no extra RPC per card.
     */
    function enhanceCards() {
      const cards = document.querySelectorAll("[data-presented-file]");
      for (const card of cards) {
        if (card.querySelector("[" + CARD_MARK + "]")) continue;
        const preview = card.querySelector(':scope > button[title]');
        const path = preview?.getAttribute("title");
        if (!path) continue;
        const actions =
          card.querySelector('[class*="_actions"]') ??
          card.firstElementChild?.lastElementChild?.lastElementChild;
        if (!actions) continue;
        const template = actions.querySelector("button:last-of-type");
        if (!template) continue;

        const button = template.cloneNode(true);
        button.setAttribute(CARD_MARK, "");
        button.setAttribute("title", "下载到本地");
        button.setAttribute("aria-label", "下载到本地");
        button.removeAttribute("aria-haspopup");
        button.removeAttribute("aria-expanded");
        button.removeAttribute("aria-controls");
        button.removeAttribute("data-state");
        button.innerHTML = downloadGlyph();
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          forceDownload(downloadHref(path));
        });
        // The split control keeps its buttons inside an inner wrapper, so the
        // clone belongs beside its template rather than beside the wrapper.
        const group = template.parentElement ?? actions;
        group.insertBefore(button, template);
      }
    }

    /* ------------------------------------------------------------------ *
     * 3. Card menu: "download" above the host applications
     * ------------------------------------------------------------------ */

    const MENU_MARK = "data-dsh-download-menu-item";
    const MENU_LABEL = "下载到本地";
    let pendingPath;
    let pendingAt = 0;

    /** Remember which card a menu gesture belongs to, so a later menu can use it. */
    function noteCardGesture(event) {
      const card = event.target?.closest?.("[data-presented-file]");
      if (!card) return;
      const path = card.querySelector(':scope > button[title]')?.getAttribute("title");
      if (!path) return;
      pendingPath = path;
      pendingAt = Date.now();
    }

    /** Replace the visible label of a cloned menu row without touching its icon. */
    function relabel(clone, label) {
      const candidates = [...clone.querySelectorAll("span, div")].filter(
        (node) => node.children.length === 0 && (node.textContent || "").trim() !== "",
      );
      const target = candidates[candidates.length - 1];
      if (target) target.textContent = label;
      else clone.textContent = label;
    }

    /** Swap a cloned row's application icon for the download glyph. */
    function reicon(clone) {
      const image = clone.querySelector("img, svg");
      if (!image) return;
      const holder = document.createElement("span");
      holder.style.cssText = "display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px";
      holder.innerHTML = downloadGlyph();
      image.replaceWith(holder);
    }

    /**
     * The card's ⋯ menu is the host's "open with" list — it names applications
     * installed on the machine running DSH, which a phone can never use. Put a
     * download row at the top of that same menu so the obvious tap downloads.
     */
    function decorateMenu() {
      if (pendingPath === undefined || Date.now() - pendingAt > 4000) return;
      const menus = document.querySelectorAll('[role="menu"]');
      for (const menu of menus) {
        if (menu.querySelector("[" + MENU_MARK + "]")) continue;
        const item = menu.querySelector('[role="menuitem"]');
        if (!item) continue;
        const row = item.cloneNode(true);
        row.setAttribute(MENU_MARK, "");
        row.removeAttribute("aria-keyshortcuts");
        row.removeAttribute("aria-checked");
        row.setAttribute("aria-label", MENU_LABEL);
        relabel(row, MENU_LABEL);
        reicon(row);
        const path = pendingPath;
        row.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          forceDownload(downloadHref(path));
          menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        item.parentElement.insertBefore(row, item);
        pendingPath = undefined;
        return;
      }
    }

    /* ------------------------------------------------------------------ *
     * 4. Preview pane: download the file that is open on the right
     * ------------------------------------------------------------------ */

    const PREVIEW_STYLE_ID = "dsh-file-download-preview-style";
    const PREVIEW_MARK = "data-dsh-preview-download";

    /** Match the host's own header tools (28px, quiet until hovered). */
    function ensurePreviewStyle() {
      if (document.getElementById(PREVIEW_STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = PREVIEW_STYLE_ID;
      style.textContent =
        ".dsh-file-download-preview{width:28px;height:28px;flex:none;display:inline-flex;" +
        "align-items:center;justify-content:center;padding:6px;border:0;border-radius:6px;" +
        "background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;line-height:1}" +
        ".dsh-file-download-preview:hover{color:var(--dsw-alias-label-primary);" +
        "background:var(--dsw-alias-interactive-bg-hover)}" +
        ".dsh-file-download-preview svg{width:15px;height:15px}";
      document.head.append(style);
    }

    // The server only serves workspace paths; cache them once so a preview of
    // some other file explains itself instead of downloading an error body.
    let rootsPromise;
    function rootsOnce() {
      rootsPromise ??= fetch("/api/files.roots", { headers: { accept: "application/json" } })
        .then((res) => (res.ok ? res.json() : undefined))
        .then((body) => (Array.isArray(body?.roots) ? body.roots.map((root) => root.path) : []))
        .catch(() => []);
      return rootsPromise;
    }

    function withinRoots(path, roots) {
      if (!roots.length) return true; // unknown: let the server decide
      return roots.some((root) => path === root || path.startsWith(root.endsWith("/") ? root : root + "/"));
    }

    function notifyOutOfScope() {
      const toast = document.createElement("div");
      toast.textContent = "该文件不在工作区内，无法下载";
      toast.style.cssText =
        "position:fixed;left:50%;bottom:42px;transform:translateX(-50%);z-index:2147483000;" +
        "padding:8px 14px;border-radius:8px;background:rgba(24,24,27,.92);color:#fff;" +
        "font-size:13px;line-height:1.4;font-family:var(--dsw-font-family,system-ui);" +
        "pointer-events:none;box-shadow:0 6px 20px rgba(0,0,0,.18)";
      document.body.append(toast);
      setTimeout(() => toast.remove(), 2600);
    }

    /**
     * The sidebar document preview renders one shared header for every renderer
     * (text, code, image, PDF, Office) and exposes it as the
     * "sidebar.right.tab.document.actions" slot with { absolutePath } — the file
     * the reader is actually looking at. One button here covers them all.
     */
    function PreviewDownloadAction(props) {
      const [roots, setRoots] = react.useState([]);
      react.useEffect(() => {
        ensurePreviewStyle();
        let alive = true;
        rootsOnce().then((list) => {
          if (alive) setRoots(list);
        });
        return () => {
          alive = false;
        };
      }, []);
      const path = props?.absolutePath;
      if (typeof path !== "string" || path === "") return null;
      return react.createElement("button", {
        type: "button",
        className: "dsh-file-download-preview",
        title: "下载到本地",
        "aria-label": "下载到本地",
        [PREVIEW_MARK]: "",
        onClick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (withinRoots(path, roots)) forceDownload(downloadHref(path));
          else notifyOutOfScope();
        },
        dangerouslySetInnerHTML: { __html: downloadGlyph() },
      });
    }

    /* ------------------------------------------------------------------ *
     * 5. Links: keep the conversation in place
     * ------------------------------------------------------------------ */

    function trapDownloadLinks(event) {
      const target = event.target;
      const anchor = target?.closest?.('a[href*="/api/files.download"], a[href*="/api/files.zip"]');
      if (!anchor) return;
      if (anchor.hasAttribute(DIRECT_MARK)) return; // our own synthetic click
      const href = anchor.getAttribute("href");
      if (!href) return;
      event.preventDefault();
      event.stopPropagation();
      forceDownload(href);
    }

    /* ------------------------------------------------------------------ *
     * Plugin body
     * ------------------------------------------------------------------ */

    function apply(ctx) {
      // The panel entry and the card buttons are independent features: if the
      // slot contract ever changes shape, keep the download buttons working and
      // report the failure instead of losing the whole plugin.
      const contribute = (slot, options, component) => {
        try {
          ctx.slots.inject(slot, () => {
            try {
              return ctx.slots.register(options, component);
            } catch (error) {
              globalThis.console?.warn?.("[dsh-file-download] slot registration failed", slot, error);
              return () => {};
            }
          });
        } catch (error) {
          globalThis.console?.warn?.("[dsh-file-download] slot injection failed", slot, error);
        }
      };
      contribute("main", { name: "main", key: PANEL_ID }, FileBrowserPanel);
      contribute(
        "sidebar.panellist",
        { name: "sidebar.panellist", id: PANEL_ID, order: 20, label: "文件管理" },
        FileBrowserIcon,
      );
      contribute(
        "sidebar.right.tab.document.actions",
        { name: "sidebar.right.tab.document.actions", id: PANEL_ID, order: 50 },
        PreviewDownloadAction,
      );

      ctx.effect(() => {
        globalThis.addEventListener("click", trapDownloadLinks, true);
        return () => globalThis.removeEventListener("click", trapDownloadLinks, true);
      }, "dsh-file-download: download link trap");

      ctx.effect(() => {
        globalThis.addEventListener("pointerdown", noteCardGesture, true);
        globalThis.addEventListener("click", noteCardGesture, true);
        return () => {
          globalThis.removeEventListener("pointerdown", noteCardGesture, true);
          globalThis.removeEventListener("click", noteCardGesture, true);
        };
      }, "dsh-file-download: card gestures");

      ctx.effect(() => {
        let scheduled = false;
        const run = () => {
          scheduled = false;
          try {
            enhanceCards();
            decorateMenu();
          } catch {
            /* an unexpected DOM shape must never break the page */
          }
        };
        const observer = new MutationObserver(() => {
          if (scheduled) return;
          scheduled = true;
          globalThis.requestAnimationFrame(run);
        });
        observer.observe(document.body, { childList: true, subtree: true });
        run();
        return () => observer.disconnect();
      }, "dsh-file-download: deliverable cards");
    }

    exports.name = "dsh-file-download";
    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});

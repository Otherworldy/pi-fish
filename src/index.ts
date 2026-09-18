import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";
import {
  DEFAULT_HOLD_KEY,
  LINE_CHOICES,
  cycleLines,
  isHoldSequence,
  lastThinkingText,
  PAGE_WIDTH,
  buildWrapIndex,
  findLine,
  isExistingFilePath,
  lastPage,
  lineFromPage,
  loadText,
  pageFromLine,
  parseHoldKey,
  parseUserPath,
} from "./book.ts";
import { ThoughtBlock, type BlockHost } from "./block.ts";
import { showReadPanel } from "./panel.ts";

const WIDGET = "read-tui";

type Saved = {
  dir: string;
  file: string | null;
  page: number;
  line: number;
  linesPerPage: number;
  holdKey: string;
  enabled: boolean;
  decoy: boolean;
  progress: Record<string, number>;
};

type Host = BlockHost & {
  saved: Saved;
  session: ExtensionContext | null;
  unsubInput: (() => void) | null;
  block: ThoughtBlock | null;
  chat: { children: any[]; addChild(c: any): void; removeChild(c: any): void } | null;
  holdTimer: ReturnType<typeof setTimeout> | null;
  lastKeyword: string;
};

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function configPath(): string {
  return join(agentDir(), "extensions", "pi-fish", "config.json");
}

function defaultSaved(): Saved {
  return { dir: "", file: null, page: 0, line: 1, linesPerPage: 4, holdKey: DEFAULT_HOLD_KEY, enabled: true, decoy: true, progress: {} };
}

function loadSaved(): Saved {
  const p = configPath();
  if (!existsSync(p)) return defaultSaved();
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<Saved>;
    return {
      ...defaultSaved(),
      ...raw,
      dir: typeof raw.dir === "string" && raw.dir ? resolve(raw.dir) : "",
      holdKey: parseHoldKey(raw.holdKey),
      decoy: raw.decoy !== false,
      line: typeof raw.line === "number" && raw.line >= 1 ? Math.floor(raw.line) : 1,
      linesPerPage: LINE_CHOICES.includes(raw.linesPerPage as (typeof LINE_CHOICES)[number])
        ? (raw.linesPerPage as (typeof LINE_CHOICES)[number])
        : 4,
      progress: raw.progress && typeof raw.progress === "object" ? raw.progress : {},
    };
  } catch {
    return defaultSaved();
  }
}

function saveSaved(saved: Saved): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(saved, null, 2)}\n`);
}

function branchEntries(ctx: ExtensionContext | null): any[] {
  const sm = ctx?.sessionManager as any;
  if (!sm) return [];
  if (typeof sm.getBranch === "function") return sm.getBranch();
  if (typeof sm.getEntries === "function") return sm.getEntries();
  return [];
}

function loadBook(host: Host): void {
  host.wrapIndex = null;
  host.raw = "";
  host.wrapWidth = 0;
  host.absFile = null;
  host.lastKeyword = "";
  if (!host.saved.dir || !host.saved.file) return;
  const abs = isAbsolute(host.saved.file) ? host.saved.file : join(host.saved.dir, host.saved.file);
  if (!existsSync(abs)) return;
  host.absFile = abs;
  host.raw = loadText(abs);
  const remembered = host.saved.progress[abs];
  if (typeof remembered === "number" && remembered >= 1) host.saved.line = Math.floor(remembered);
  if (!(host.saved.line >= 1)) host.saved.line = 1;
}

function persistPage(host: Host): void {
  if (host.absFile) host.saved.progress[host.absFile] = host.saved.line;
  saveSaved(host.saved);
}

function refreshPreview(host: Host): void {
  host.preview = lastThinkingText(branchEntries(host.session));
}

function refreshBook(host: Host): void {
  mountInChat(host);
  host.tui?.requestRender(true);
}

function walk(root: any, visit: (n: any) => void): void {
  const seen = new Set<any>();
  const go = (value: any) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const child of value) go(child);
      return;
    }
    visit(value);
    if (Array.isArray(value.children)) for (const child of value.children) go(child);
    try {
      const mounted = value.getMountedRoots?.();
      if (Array.isArray(mounted)) for (const child of mounted) go(child);
    } catch {
      // lazy tui proxy
    }
  };
  go(root);
}

function isChatMessage(n: any): boolean {
  if (!n || typeof n !== "object") return false;
  if (n.lastMessage?.role === "assistant") return true;
  return typeof n.text === "string" && typeof n.rebuild === "function";
}

function findChatContainer(tui: any): Host["chat"] {
  let found: Host["chat"] = null;
  walk(tui, (n) => {
    if (Array.isArray(n?.children) && n.children.some(isChatMessage)) found = n;
  });
  if (found) return found;
  walk(tui, (n) => {
    if (n?.followEnd === true && Array.isArray(n.children) && n.children[0]?.children) {
      const kids = n.children[0].children;
      found = kids[kids.length - 1] ?? null;
    }
  });
  return found;
}

function mountInChat(host: Host): void {
  const tui = host.tui as any;
  if (!tui || !host.block) return;
  host.chat ??= findChatContainer(tui);
  const chat = host.chat;
  if (!chat?.children || typeof chat.addChild !== "function") return;
  const idx = chat.children.indexOf(host.block);
  if (!host.saved.enabled || !host.absFile) {
    if (idx >= 0) chat.removeChild(host.block);
    return;
  }
  if (idx === chat.children.length - 1) return;
  if (idx >= 0) chat.removeChild(host.block);
  chat.addChild(host.block);
}

export default function piRead(pi: ExtensionAPI) {
  const host: Host = {
    saved: loadSaved(),
    wrapIndex: null,
    raw: "",
    wrapWidth: 0,
    absFile: null,
    expanded: false,
    preview: lastThinkingText([]),
    theme: null,
    tui: null,
    session: null,
    unsubInput: null,
    block: null,
    chat: null,
    holdTimer: null,
    lastKeyword: "",
    turnPage: () => {},
    hideHold: () => {},
  };
  loadBook(host);

  function bindTui(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    host.theme = ctx.ui.theme;
    ctx.ui.setWidget(WIDGET, (tui, theme) => {
      host.tui = tui as Host["tui"];
      host.theme = theme;
      host.block ??= new ThoughtBlock(host);
      return {
        render() {
          mountInChat(host);
          return [];
        },
        invalidate() {},
      };
    });
  }

  function bindKeys(ctx: ExtensionContext) {
    host.unsubInput?.();
    host.unsubInput = null;
    if (ctx.mode !== "tui") return;
    host.unsubInput = ctx.ui.onTerminalInput((data) => {
      if (!host.absFile || !host.saved.enabled) return;
      if (matchesKey(data, host.saved.holdKey) || isHoldSequence(data, host.saved.holdKey)) {
        if (isKeyRelease(data)) hideHold();
        else showHold(host.expanded || isKeyRepeat(data));
        return { consume: true };
      }
      if (matchesKey(data, "alt+[") || matchesKey(data, "alt+]")) {
        applyLines(cycleLines(host.saved.linesPerPage, matchesKey(data, "alt+]") ? 1 : -1));
        return { consume: true };
      }
    });
  }

  function showHold(repeating: boolean) {
    if (!host.expanded) {
      host.expanded = true;
      refreshBook(host);
    }
    if (host.holdTimer) clearTimeout(host.holdTimer);
    // ponytail: no key-up on some terminals; hide shortly after last repeat
    host.holdTimer = setTimeout(hideHold, repeating ? 120 : 1000);
  }

  function hideHold() {
    if (host.holdTimer) {
      clearTimeout(host.holdTimer);
      host.holdTimer = null;
    }
    if (!host.expanded) return;
    host.expanded = false;
    refreshBook(host);
  }
  host.hideHold = hideHold;

  function setDir(dir: string) {
    host.saved.dir = dir;
    if (host.saved.file && !existsSync(join(dir, host.saved.file))) {
      host.saved.file = null;
      host.absFile = null;
      host.raw = "";
      host.wrapIndex = null;
      refreshBook(host);
    }
    saveSaved(host.saved);
  }

  function applyPath(raw: string): string | null {
    const parsed = parseUserPath(raw);
    if (!parsed) return null;
    host.saved.dir = parsed.dir;
    if (parsed.file) {
      host.saved.file = parsed.file;
      host.saved.enabled = true;
      host.saved.line = host.saved.progress[join(host.saved.dir, parsed.file)] ?? 1;
      loadBook(host);
      persistPage(host);
      host.expanded = false;
      if (host.session) {
        bindTui(host.session);
        refreshBook(host);
      }
    } else {
      host.saved.file = null;
      host.absFile = null;
      host.raw = "";
      host.wrapIndex = null;
      saveSaved(host.saved);
      refreshBook(host);
    }
    return parsed.file ? join(parsed.dir, parsed.file) : parsed.dir;
  }

  function applyLines(n: number) {
    if (n === host.saved.linesPerPage) return;
    host.saved.linesPerPage = n;
    if (host.wrapIndex) host.saved.page = pageFromLine(host.wrapIndex, host.saved.line, n);
    persistPage(host);
    refreshBook(host);
  }

  function turnPage(delta: number) {
    if (!host.absFile || !host.raw) return;
    if (!host.wrapIndex) {
      const w = host.wrapWidth || PAGE_WIDTH;
      host.wrapIndex = buildWrapIndex(host.raw, w);
      host.wrapWidth = w;
    }
    const idx = host.wrapIndex;
    const n = host.saved.linesPerPage;
    const last = lastPage(idx, n);
    const cur = Math.max(0, Math.min(last, host.saved.page));
    const next = Math.max(0, Math.min(last, cur + delta));
    if (next === cur) return;
    host.saved.line = lineFromPage(idx, next, n);
    host.saved.page = next;
    persistPage(host);
    refreshBook(host);
  }

  host.turnPage = turnPage;

  function jumpToLine(line1: number) {
    if (!host.absFile || !host.raw) return;
    host.saved.line = Math.max(1, Math.floor(line1));
    if (host.wrapIndex) host.saved.page = pageFromLine(host.wrapIndex, host.saved.line, host.saved.linesPerPage);
    persistPage(host);
    refreshBook(host);
  }

  function jumpToKeyword(keyword: string) {
    if (!host.absFile || !host.raw || !keyword) return;
    const from = keyword === host.lastKeyword ? host.saved.line + 1 : host.saved.line;
    host.lastKeyword = keyword;
    const line = findLine(host.raw, keyword, from);
    if (line) jumpToLine(line);
  }

  pi.on("session_start", (_e, ctx) => {
    host.session = ctx;
    host.expanded = false;
    refreshPreview(host);
    bindTui(ctx);
    bindKeys(ctx);
  });

  pi.on("session_shutdown", (_e, ctx) => {
    host.unsubInput?.();
    host.unsubInput = null;
    if (host.holdTimer) {
      clearTimeout(host.holdTimer);
      host.holdTimer = null;
    }
    if (host.block && host.chat?.children?.includes(host.block)) host.chat.removeChild(host.block);
    host.tui = null;
    host.session = null;
    host.block = null;
    host.chat = null;
    if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET, undefined);
  });

  pi.on("message_end", (event) => {
    if (event.message?.role !== "assistant") return;
    refreshPreview(host);
    refreshBook(host);
  });

  pi.on("message_update", () => {
    mountInChat(host);
  });

  pi.on("session_tree", () => {
    host.chat = null;
    refreshBook(host);
  });

  pi.on("session_compact", () => {
    host.chat = null;
    refreshBook(host);
  });

  pi.registerCommand("read", {
    description: "Local txt in a thinking-style block",
    handler: async (args, ctx) => {
      const rest = args.trim();
      host.session = ctx;
      if (/^\d+$/.test(rest)) {
        jumpToLine(Number(rest));
        return;
      }
      if (rest && host.absFile && !isExistingFilePath(rest)) {
        jumpToKeyword(rest);
        return;
      }
      if (rest && parseUserPath(rest)) {
        applyPath(rest);
        bindTui(ctx);
        bindKeys(ctx);
        return;
      }
      bindTui(ctx);
      bindKeys(ctx);
      await showReadPanel(
        ctx,
        {
          get dir() {
            return host.saved.dir;
          },
          get file() {
            return host.saved.file;
          },
          get linesPerPage() {
            return host.saved.linesPerPage;
          },
          get holdKey() {
            return host.saved.holdKey;
          },
          get enabled() {
            return host.saved.enabled;
          },
          get decoy() {
            return host.saved.decoy;
          },
        },
        {
          setDir,
          setLines(n) {
            applyLines(n);
          },
          setHoldKey(key) {
            host.saved.holdKey = parseHoldKey(key);
            saveSaved(host.saved);
          },
          setEnabled(on) {
            host.saved.enabled = on;
            if (!on) host.expanded = false;
            saveSaved(host.saved);
            bindTui(ctx);
            refreshBook(host);
          },
          setDecoy(on) {
            host.saved.decoy = on;
            saveSaved(host.saved);
            refreshBook(host);
          },
          openFile(name) {
            host.saved.file = name;
            host.saved.enabled = true;
            host.saved.line = host.saved.progress[join(host.saved.dir, name)] ?? 1;
            loadBook(host);
            persistPage(host);
            host.expanded = false;
            bindTui(ctx);
            refreshBook(host);
          },
          applyPath,
        },
      );
    },
  });
}

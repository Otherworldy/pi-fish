import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export const PAGE_WIDTH = 72;
export const LINE_CHOICES = [4, 8, 12, 16, 20, 24] as const;
export const PREVIEW_LINES = 3;
export const FALLBACK_THINKING = "Considering the request and the next steps.";
export const DEFAULT_HOLD_KEY = "f9";

export function parseHoldKey(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_HOLD_KEY;
  const s = value.trim().toLowerCase();
  if (!s || s.length > 24) return DEFAULT_HOLD_KEY;
  if (s === "escape" || s === "esc" || s === "enter" || s === "return" || s === "tab") return DEFAULT_HOLD_KEY;
  return s;
}

const FKEY_CSI: Record<string, string> = {
  f1: "11",
  f2: "12",
  f3: "13",
  f4: "14",
  f5: "15",
  f6: "17",
  f7: "18",
  f8: "19",
  f9: "20",
  f10: "21",
  f11: "23",
  f12: "24",
};

const FKEY_U: Record<string, number> = {
  f1: 57376,
  f2: 57377,
  f3: 57378,
  f4: 57379,
  f5: 57380,
  f6: 57381,
  f7: 57382,
  f8: 57383,
  f9: 57384,
  f10: 57385,
  f11: 57386,
  f12: 57387,
};

/** Kitty/xterm send F-keys as CSI ~ / CSI u with ;mod:event — matchesKey only accepts the bare sequence. */
export function isHoldSequence(data: string, holdKey: string): boolean {
  const num = FKEY_CSI[holdKey];
  if (num) {
    if (data === `\x1b[${num}~`) return true;
    if (data.startsWith(`\x1b[${num};`)) return true;
  }
  const u = FKEY_U[holdKey];
  if (u && (data === `\x1b[${u}u` || data.startsWith(`\x1b[${u};`) || data.startsWith(`\x1b[${u}:`))) return true;
  const ss3 = ({ f1: "P", f2: "Q", f3: "R", f4: "S" } as Record<string, string>)[holdKey];
  if (ss3 && data === `\x1bO${ss3}`) return true;
  return false;
}

export function holdKeyFromData(data: string): string | undefined {
  for (const key of Object.keys(FKEY_CSI)) {
    if (isHoldSequence(data, key)) return key;
  }
  return undefined;
}

export function cycleLines(current: number, delta: number): number {
  const i = LINE_CHOICES.indexOf(current as (typeof LINE_CHOICES)[number]);
  const idx = Math.max(0, Math.min(LINE_CHOICES.length - 1, (i < 0 ? 0 : i) + delta));
  return LINE_CHOICES[idx]!;
}

export type DirEntry = {
  value: string;
  label: string;
  description: string;
  kind: "up" | "dir" | "file" | "empty";
};

export function charWidth(cp: number): number {
  if (cp <= 31 || (cp >= 0x7f && cp <= 0x9f)) return 0;
  if (cp <= 0x7e) return 1;
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  ) {
    return 2;
  }
  return 1;
}

export function wrapLine(line: string, width: number): string[] {
  const max = Math.max(1, width);
  const out: string[] = [];
  let cur = "";
  let w = 0;
  for (const ch of line) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (cw > max) {
      if (cur) out.push(cur);
      out.push(ch);
      cur = "";
      w = 0;
      continue;
    }
    if (cur && w + cw > max) {
      out.push(cur);
      cur = ch;
      w = cw;
    } else {
      cur += ch;
      w += cw;
    }
  }
  out.push(cur);
  return out.length ? out : [""];
}

function fileLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

/** 1-based file line of the next substring hit, wrapping. 0 if none. */
export function findLine(text: string, keyword: string, fromLine1 = 1): number {
  if (!keyword) return 0;
  const rows = fileLines(text);
  const n = rows.length;
  if (!n) return 0;
  const start = ((Math.floor(fromLine1) - 1) % n + n) % n;
  for (let i = 0; i < n; i++) {
    const idx = (start + i) % n;
    if (rows[idx]!.includes(keyword)) return idx + 1;
  }
  return 0;
}

export function paginate(text: string, width = PAGE_WIDTH, linesPerPage = 4): string[] {
  const lines: string[] = [];
  for (const line of fileLines(text)) lines.push(...wrapLine(line, width));
  if (lines.length === 0) return [""];
  const n = Math.max(1, linesPerPage);
  const pages: string[] = [];
  for (let i = 0; i < lines.length; i += n) pages.push(lines.slice(i, i + n).join("\n"));
  return pages;
}

export type WrapIndex = {
  width: number;
  rows: string[];
  starts: Uint32Array;
};

export function buildWrapIndex(text: string, width: number): WrapIndex {
  const w = Math.max(1, width);
  const rows = fileLines(text);
  const starts = new Uint32Array(rows.length + 1);
  for (let i = 0; i < rows.length; i++) starts[i + 1] = starts[i]! + wrapLine(rows[i]!, w).length;
  return { width: w, rows, starts };
}

export function pageFromLine(index: WrapIndex, line1: number, linesPerPage: number): number {
  const n = Math.max(1, linesPerPage);
  if (!index.rows.length) return 0;
  const i = Math.max(0, Math.min(index.rows.length - 1, Math.floor(line1) - 1));
  return Math.floor(index.starts[i]! / n);
}

export function lastPage(index: WrapIndex, linesPerPage: number): number {
  const n = Math.max(1, linesPerPage);
  const total = index.starts[index.rows.length] ?? 0;
  if (total <= 0) return 0;
  return Math.floor((total - 1) / n);
}

/** Keep page if it still sits inside this source line's wrapped span. */
export function clampPage(index: WrapIndex, line1: number, page: number, linesPerPage: number): number {
  const n = Math.max(1, linesPerPage);
  const first = pageFromLine(index, line1, n);
  if (!index.rows.length) return first;
  const i = Math.max(0, Math.min(index.rows.length - 1, Math.floor(line1) - 1));
  const end = index.starts[i + 1] ?? 0;
  const last = end > 0 ? Math.floor((end - 1) / n) : first;
  return page >= first && page <= last ? page : first;
}

export function lineFromPage(index: WrapIndex, page: number, linesPerPage: number): number {
  const n = Math.max(1, linesPerPage);
  if (!index.rows.length) return 1;
  const total = index.starts[index.rows.length]!;
  const target = Math.max(0, page) * n;
  if (target >= total) return index.rows.length;
  let lo = 0;
  let hi = index.rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (index.starts[mid]! <= target) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

export function pageText(index: WrapIndex, page: number, linesPerPage: number): string {
  const n = Math.max(1, linesPerPage);
  const total = index.starts[index.rows.length] ?? 0;
  const start = Math.max(0, page) * n;
  if (start >= total) return "";
  const out: string[] = [];
  const line0 = lineFromPage(index, page, n) - 1;
  let wrapped = index.starts[line0]!;
  for (let i = line0; i < index.rows.length && out.length < n; i++) {
    for (const part of wrapLine(index.rows[i]!, index.width)) {
      if (wrapped >= start && out.length < n) out.push(part);
      wrapped++;
      if (out.length >= n) break;
    }
  }
  return out.join("\n");
}

/** 1-based txt line → page index after wrap. */
export function pageForLine(text: string, line1: number, width = PAGE_WIDTH, linesPerPage = 4): number {
  return pageFromLine(buildWrapIndex(text, width), line1, linesPerPage);
}

/** Page index → 1-based file line at the top of that page. */
export function lineAtPage(text: string, page: number, width = PAGE_WIDTH, linesPerPage = 4): number {
  return lineFromPage(buildWrapIndex(text, width), page, linesPerPage);
}

export function decodeBytes(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString("utf8");
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(buf.subarray(2));
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(buf.subarray(2));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder("gb18030").decode(buf);
    } catch {
      return buf.toString("utf8");
    }
  }
}

export function loadText(path: string): string {
  return decodeBytes(readFileSync(path));
}

/** C:\\ through Z:\\ that currently exist. Skip A:/B: — floppy/optical existsSync can hang. */
export function listDrives(): string[] {
  if (process.platform !== "win32") return [];
  const out: string[] = [];
  for (let i = 67; i <= 90; i++) {
    const p = `${String.fromCharCode(i)}:\\`;
    try {
      if (existsSync(p)) out.push(p);
    } catch {
      // skip
    }
  }
  return out;
}

export function listDir(dir: string): DirEntry[] {
  const out: DirEntry[] = [];
  const parent = dirname(dir);
  if (parent !== dir) out.push({ value: "..", label: "..", description: "parent", kind: "up" });
  const here = resolve(dir);
  for (const p of listDrives()) {
    if (resolve(p) === here) continue;
    out.push({ value: p, label: p, description: "drive", kind: "dir" });
  }
  if (!existsSync(dir)) {
    out.push({ value: "", label: "(missing directory)", description: "edit path above", kind: "empty" });
    return out;
  }
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    out.push({ value: "", label: "(unreadable)", description: "", kind: "empty" });
    return out;
  }
  const dirs: string[] = [];
  const files: string[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (st.isDirectory()) dirs.push(name);
      else if (st.isFile() && /\.txt$/i.test(name)) files.push(name);
    } catch {
      // skip broken entries
    }
  }
  dirs.sort((a, b) => a.localeCompare(b));
  files.sort((a, b) => a.localeCompare(b));
  for (const name of dirs) out.push({ value: name, label: `${name}/`, description: "folder", kind: "dir" });
  for (const name of files) out.push({ value: name, label: name, description: "txt", kind: "file" });
  if (out.every((e) => e.kind === "up")) {
    out.push({ value: "", label: "(no .txt or folders)", description: "", kind: "empty" });
  }
  return out;
}

export function pageAt(pages: string[], page: number): string {
  if (!pages.length) return "";
  const i = Math.max(0, Math.min(page, pages.length - 1));
  return pages[i] ?? "";
}

export function wrapBody(text: string, width: number): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) out.push(...wrapLine(line, width));
  return out.length ? out : [""];
}

export function thoughtTitle(file: string | null): string {
  if (!file) return "Thought";
  let h = 0;
  for (let i = 0; i < file.length; i++) h = (h + file.charCodeAt(i) * (i + 1)) >>> 0;
  return `Thought for ${(h % 13) + 5}s`;
}

export function thoughtContent(opts: {
  expanded: boolean;
  preview: string;
  page: string;
  width: number;
  title: string;
}): { title: string; hint: string; body: string[] } {
  const inner = Math.max(1, opts.width - 2);
  if (opts.expanded) {
    return { title: opts.title, hint: "", body: wrapBody(opts.page, inner) };
  }
  const preview = wrapBody(opts.preview, inner);
  const hidden = Math.max(0, preview.length - PREVIEW_LINES);
  const visible = hidden > 0 ? preview.slice(-PREVIEW_LINES) : preview;
  const hint =
    hidden > 0 ? ` • (${hidden} more lines, click to show more)` : " • click to show more";
  return { title: opts.title, hint, body: visible };
}

export function lastThinkingText(
  entries: Array<{ type?: string; message?: { role?: string; content?: unknown } }>,
): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type !== "message" || e.message?.role !== "assistant") continue;
    const content = e.message.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const item = content[j] as { type?: string; thinking?: string };
      if (item?.type === "thinking" && typeof item.thinking === "string" && item.thinking.trim()) {
        return item.thinking;
      }
    }
  }
  return FALLBACK_THINKING;
}

export function parentDir(dir: string): string {
  const next = dirname(dir);
  return next || dir;
}

export function normalizeDir(dir: string): string {
  return resolve(dir);
}

export function joinDir(dir: string, name: string): string {
  if (isAbsolute(name)) return resolve(name);
  return resolve(join(dir, name));
}

export function parseUserPath(raw: string): { dir: string; file: string | null } | null {
  let s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  if (!s) return null;
  if (s.startsWith("~")) {
    const rest = s.slice(1).replace(/^[\\/]+/, "");
    s = rest ? join(homedir(), rest) : homedir();
  }
  const abs = resolve(s);
  try {
    const st = statSync(abs);
    if (st.isDirectory()) return { dir: abs, file: null };
    if (st.isFile()) return { dir: dirname(abs), file: basename(abs) };
  } catch {
    if (/\.txt$/i.test(abs)) return { dir: dirname(abs), file: basename(abs) };
    return { dir: abs, file: null };
  }
  return { dir: dirname(abs), file: basename(abs) };
}

export function isExistingFilePath(raw: string): boolean {
  const parsed = parseUserPath(raw);
  if (!parsed?.file) return false;
  try {
    return statSync(join(parsed.dir, parsed.file)).isFile();
  } catch {
    return false;
  }
}

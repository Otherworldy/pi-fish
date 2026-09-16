import type { Theme } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import {
  Input,
  Key,
  SelectList,
  SettingsList,
  isKeyRelease,
  matchesKey,
  parseKey,
  truncateToWidth,
  type Component,
  type SelectItem,
  type SettingItem,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
  LINE_CHOICES,
  holdKeyFromData,
  joinDir,
  listDir,
  parseHoldKey,
  parentDir,
  type DirEntry,
} from "./book.ts";

export type PanelState = {
  dir: string;
  file: string | null;
  linesPerPage: number;
  holdKey: string;
  enabled: boolean;
};

export type PanelHandlers = {
  setDir(dir: string): void;
  setLines(n: number): void;
  setHoldKey(key: string): void;
  setEnabled(on: boolean): void;
  openFile(name: string): void;
  applyPath(raw: string): string | null;
};

export function showReadPanel(
  ctx: { ui: { custom: Function }; mode?: string },
  state: PanelState,
  handlers: PanelHandlers,
): Promise<void> {
  if (ctx.mode !== "tui") return Promise.resolve();
  return ctx.ui.custom(
    (_tui: TUI, theme: Theme, _kb: unknown, done: (v: null) => void) => {
      const sync = { run() {} };
      const items: SettingItem[] = [
        {
          id: "enabled",
          label: "Enabled",
          description: "Show the thought-style block under the latest message",
          currentValue: state.enabled ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "path",
          label: "Path",
          description: "Address bar — folder or .txt; File follows",
          currentValue: pathDisplay(state),
          submenu: (cur, close) =>
            new PathInput(cur === "none" ? "" : cur, theme, (value) => {
              if (!value) {
                close();
                return;
              }
              handlers.applyPath(value);
              sync.run();
              close(pathDisplay(state));
            }),
        },
        {
          id: "file",
          label: "File",
          description: "Browse the folder in Path",
          currentValue: state.file ?? "none",
          submenu: (_cur, close) =>
            new FileBrowser(startDir(state.dir), state.file, (dir, file) => {
              handlers.setDir(dir);
              if (file) handlers.openFile(file);
              sync.run();
              close(state.file ?? "none");
            }),
        },
        {
          id: "holdKey",
          label: "Hold key",
          description: "Hold to show the page, release to hide",
          currentValue: state.holdKey,
          submenu: (_cur, close) =>
            new CaptureKey((key) => {
              if (key) handlers.setHoldKey(key);
              close(key ?? undefined);
            }),
        },
        {
          id: "lines",
          label: "Lines per page",
          description: "How many lines to show while holding",
          currentValue: String(state.linesPerPage),
          values: LINE_CHOICES.map(String),
        },
      ];
      const list = new SettingsList(
        items,
        8,
        getSettingsListTheme(),
        (id, value) => {
          if (id === "lines") handlers.setLines(Number(value));
          if (id === "enabled") handlers.setEnabled(value === "on");
          if (id === "holdKey") handlers.setHoldKey(value);
          if (id === "path" || id === "file") sync.run();
        },
        () => done(null),
      );
      sync.run = () => {
        list.updateValue("path", pathDisplay(state));
        list.updateValue("file", state.file ?? "none");
      };
      return new Frame(theme, list);
    },
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: 64, maxHeight: 20 },
    },
  );
}

class Frame implements Component {
  constructor(
    private readonly theme: Theme,
    private readonly inner: Component,
  ) {}

  invalidate(): void {
    this.inner.invalidate?.();
  }

  handleInput(data: string): void {
    this.inner.handleInput?.(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.y <= 0) return undefined;
    return this.inner.handleMouse?.({
      ...event,
      y: event.y - 1,
      x: Math.max(0, event.x - 1),
    });
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - 2);
    const color = (s: string) => this.theme.fg("border", s);
    const bar = "─".repeat(inner);
    const lines = this.inner.render(inner);
    return [
      color(`┌${bar}┐`),
      ...lines.map((l) => `${color("│")}${truncateToWidth(l, inner, "", true)}${color("│")}`),
      color(`└${bar}┘`),
    ];
  }
}

function pathDisplay(state: PanelState): string {
  if (state.dir && state.file) return joinDir(state.dir, state.file);
  return state.dir || "none";
}

class PathInput implements Component {
  private readonly input = new Input({ prompt: "  ", placeholder: "/path/or/file.txt" });
  private readonly theme: Theme;
  private readonly done: (value?: string) => void;

  constructor(initial: string, theme: Theme, done: (value?: string) => void) {
    this.theme = theme;
    this.done = done;
    this.input.focused = true;
    if (initial) this.input.setValue(initial);
    this.input.onSubmit = (value) => {
      const s = value.trim();
      if (!s) {
        this.done();
        return;
      }
      this.done(s);
    };
    this.input.onEscape = () => this.done();
  }

  invalidate(): void {
    this.input.invalidate();
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    this.input.handleInput(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.y !== 1) return undefined;
    return this.input.handleMouse({ ...event, y: 0 });
  }

  render(width: number): string[] {
    const dim = (s: string) => this.theme.fg("dim", s);
    return [
      dim("  Type a folder or .txt path"),
      this.input.render(width)[0] ?? "",
      dim("  Enter apply · Esc cancel"),
    ];
  }
}

function startDir(dir: string): string {
  if (dir && existsSync(dir)) return dir;
  return homedir();
}

class FileBrowser implements Component {
  private dir: string;
  private list: SelectList;
  private entries: DirEntry[] = [];
  private readonly currentFile: string | null;
  private readonly done: (dir: string, file?: string) => void;

  constructor(dir: string, currentFile: string | null, done: (dir: string, file?: string) => void) {
    this.dir = dir;
    this.currentFile = currentFile;
    this.done = done;
    this.list = this.makeList();
  }

  invalidate(): void {
    this.list.invalidate();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.list.handleMouse(event);
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    this.list.handleInput(data);
  }

  render(width: number): string[] {
    return this.list.render(width);
  }

  private makeList(): SelectList {
    this.entries = listDir(this.dir);
    const items: SelectItem[] = [
      { value: "__cwd", label: this.dir, description: "current" },
      ...this.entries.map((e) => ({
        value: e.kind === "up" ? ".." : e.value,
        label: e.kind === "up" ? ".." : e.label,
        description: e.description,
      })),
    ];
    const list = new SelectList(items, 14, getSelectListTheme());
    list.onSelect = (item) => this.pick(item.value);
    list.onCancel = () => this.done(this.dir);
    if (this.currentFile) {
      const i = this.entries.findIndex((e) => e.kind === "file" && e.value === this.currentFile);
      if (i >= 0) list.setSelectedIndex(i + 1);
    }
    return list;
  }

  private pick(value: string): void {
    if (value === "__cwd") return;
    const entry = this.entries.find((e) => (e.kind === "up" ? value === ".." : e.value === value));
    if (!entry || entry.kind === "empty") return;
    if (entry.kind === "up") {
      this.dir = parentDir(this.dir);
      this.list = this.makeList();
      return;
    }
    if (entry.kind === "dir") {
      this.dir = joinDir(this.dir, entry.value);
      this.list = this.makeList();
      return;
    }
    this.done(this.dir, entry.value);
  }
}

class CaptureKey implements Component {
  private readonly done: (key?: string) => void;
  constructor(done: (key?: string) => void) {
    this.done = done;
  }
  invalidate(): void {}
  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (matchesKey(data, Key.escape)) {
      this.done();
      return;
    }
    const key = parseKey(data) ?? holdKeyFromData(data);
    if (key) this.done(parseHoldKey(key));
  }
  render(_width: number): string[] {
    return ["", "  Press the key you want to hold", "  Esc to cancel"];
  }
}

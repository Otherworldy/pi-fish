import { truncateToWidth, visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { pageAt, paginate, thoughtContent, thoughtTitle } from "./book.ts";

export type BlockTheme = {
  fg(color: string, text: string): string;
  italic(text: string): string;
};

export type BlockHost = {
  saved: { enabled: boolean; page: number; linesPerPage: number };
  pages: string[];
  raw: string;
  wrapWidth: number;
  absFile: string | null;
  expanded: boolean;
  preview: string;
  theme: BlockTheme | null;
  tui: { requestRender: (force?: boolean) => void } | null;
  turnPage: (delta: number) => void;
  hideHold: () => void;
};

function paint(theme: BlockTheme | null, color: string, text: string): string {
  return theme ? theme.fg(color, text) : text;
}

function thinkingStyle(theme: BlockTheme | null, text: string): string {
  return theme ? theme.italic(theme.fg("thinkingText", text)) : text;
}

function padPreviewLine(line: string, width: number, padding: number): string {
  const left = padding > 0 ? " ".repeat(padding) : "";
  const right = padding > 0 ? " ".repeat(padding) : "";
  const withMargins = left + line + right;
  return withMargins + " ".repeat(Math.max(0, width - visibleWidth(withMargins)));
}

function relayout(host: BlockHost, width: number): void {
  const inner = Math.max(1, width - 2);
  if (host.wrapWidth === inner) return;
  host.wrapWidth = inner;
  if (!host.raw) {
    host.pages = [];
    return;
  }
  host.pages = paginate(host.raw, inner, host.saved.linesPerPage);
  host.saved.page = Math.max(0, Math.min(host.saved.page, Math.max(0, host.pages.length - 1)));
}

export class ThoughtBlock implements Component {
  host: BlockHost;

  constructor(host: BlockHost) {
    this.host = host;
  }

  invalidate(): void {}

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel" && this.host.expanded && this.host.absFile) {
      this.host.turnPage((event.wheelDelta ?? 0) < 0 ? -1 : 1);
      return { handled: true };
    }
    if (event.type === "click" && this.host.expanded && event.button !== "right" && event.button !== "middle") {
      this.host.hideHold();
      return { handled: true };
    }
    return undefined;
  }

  render(width: number): string[] {
    const w = Math.max(8, width);
    relayout(this.host, w);
    const theme = this.host.theme;
    const pad = 1;
    const inner = Math.max(1, w - pad * 2);
    const page = this.host.absFile ? pageAt(this.host.pages, this.host.saved.page) : this.host.preview;
    const content = thoughtContent({
      expanded: this.host.expanded,
      preview: this.host.preview,
      page,
      width: w,
      title: thoughtTitle(this.host.absFile),
    });
    const heading = padPreviewLine(
      thinkingStyle(theme, content.title) + (content.hint ? paint(theme, "dim", content.hint) : ""),
      w,
      pad,
    );
    if (!content.body.length) return ["", heading];
    const body = content.body.map((line) =>
      padPreviewLine(thinkingStyle(theme, truncateToWidth(line, inner)), w, pad),
    );
    return ["", heading, ...body];
  }
}

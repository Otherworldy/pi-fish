import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  DEFAULT_HOLD_KEY,
  decodeBytes,
  FALLBACK_THINKING,
  cycleLines,
  holdKeyFromData,
  isHoldSequence,
  lastThinkingText,
  joinDir,
  listDir,
  listDrives,
  loadText,
  parentDir,
  pageAt,
  pageForLine,
  paginate,
  parseHoldKey,
  parseUserPath,
  thoughtContent,
  thoughtTitle,
  wrapLine,
} from "../src/book.ts";

test("wrapLine CJK width 2", () => {
  const lines = wrapLine("你好世界", 4);
  assert.deepEqual(lines, ["你好", "世界"]);
});

test("paginate splits wrapped lines", () => {
  const pages = paginate("aaaa\nbbbb\ncccc", 4, 2);
  assert.equal(pages.length, 2);
  assert.equal(pages[0], "aaaa\nbbbb");
  assert.equal(pages[1], "cccc");
});

test("pageForLine is 1-based file line", () => {
  const text = "aaaa\nbbbb\ncccc";
  assert.equal(pageForLine(text, 1, 4, 2), 0);
  assert.equal(pageForLine(text, 2, 4, 2), 0);
  assert.equal(pageForLine(text, 3, 4, 2), 1);
  assert.equal(pageForLine(text, 99, 4, 2), 1);
  assert.equal(pageForLine(text, 0, 4, 2), 0);
});

test("pageAt clamps", () => {
  assert.equal(pageAt(["a", "b"], 0), "a");
  assert.equal(pageAt(["a", "b"], 9), "b");
  assert.equal(pageAt([], 0), "");
});

test("lastThinkingText uses latest assistant thinking", () => {
  assert.equal(lastThinkingText([]), FALLBACK_THINKING);
  assert.equal(
    lastThinkingText([
      { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "old" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "new" }, { type: "text" }] } },
    ]),
    "new",
  );
});

test("decodeBytes utf8 and gb18030", () => {
  assert.equal(decodeBytes(Buffer.from("你好", "utf8")), "你好");
  assert.equal(decodeBytes(Buffer.from([0xc4, 0xe3, 0xba, 0xc3])), "你好");
  assert.equal(decodeBytes(Buffer.from([0xef, 0xbb, 0xbf, 0xe4, 0xbd, 0xa0])), "你");
});

test("loadText reads the local gb18030 novel", () => {
  const text = loadText("/home/Node/pi-fish/[附带番外]方舟[废土]（七切）.txt");
  assert.equal(text.includes("\uFFFD"), false);
  assert.match(text, /方舟/);
  assert.ok(paginate(text).length > 1);
});

test("listDir shows txt and folders", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-read-"));
  mkdirSync(join(dir, "more"));
  writeFileSync(join(dir, "a.txt"), "hi");
  writeFileSync(join(dir, "skip.md"), "no");
  const entries = listDir(dir);
  assert.ok(entries.some((e) => e.kind === "up"));
  assert.ok(entries.some((e) => e.kind === "dir" && e.value === "more"));
  assert.ok(entries.some((e) => e.kind === "file" && e.value === "a.txt"));
  assert.equal(entries.some((e) => e.value === "skip.md"), false);
});

test("joinDir uses platform path", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-read-"));
  mkdirSync(join(dir, "more"));
  assert.equal(joinDir(dir, "more"), resolve(dir, "more"));
  assert.equal(parentDir(joinDir(dir, "more")), resolve(dir));
  assert.equal(joinDir(dir, resolve(dir, "more")), resolve(dir, "more"));
});

test("parseUserPath file dir quotes tilde", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-read-"));
  const file = join(dir, "n.txt");
  writeFileSync(file, "hi");
  assert.deepEqual(parseUserPath(`"${file}"`), { dir: resolve(dir), file: "n.txt" });
  assert.deepEqual(parseUserPath(dir), { dir: resolve(dir), file: null });
  assert.equal(parseUserPath("   "), null);
  assert.equal(parseUserPath("~")?.dir, resolve(homedir()));
});

test("listDrives only on windows", () => {
  if (process.platform === "win32") {
    assert.ok(listDrives().every((d) => /^[C-Z]:\\$/.test(d)));
  } else {
    assert.deepEqual(listDrives(), []);
  }
});

test("cycleLines and hold key", () => {
  assert.equal(cycleLines(16, 1), 20);
  assert.equal(cycleLines(24, 1), 24);
  assert.equal(cycleLines(8, -1), 4);
  assert.equal(cycleLines(4, -1), 4);
  assert.equal(parseHoldKey("F8"), "f8");
  assert.equal(parseHoldKey("escape"), DEFAULT_HOLD_KEY);
  assert.equal(parseHoldKey(""), DEFAULT_HOLD_KEY);
  assert.equal(isHoldSequence("\x1b[20~", "f9"), true);
  assert.equal(isHoldSequence("\x1b[20;1:2~", "f9"), true);
  assert.equal(isHoldSequence("\x1b[20;1:3~", "f9"), true);
  assert.equal(isHoldSequence("\x1b[57384;1:3u", "f9"), true);
  assert.equal(isHoldSequence("\x1b[20;1:3~", "f8"), false);
  assert.equal(holdKeyFromData("\x1b[20;1:3~"), "f9");
});

test("thoughtTitle looks like compact-thinking", () => {
  assert.equal(thoughtTitle(null), "Thought");
  assert.match(thoughtTitle("/tmp/a.txt"), /^Thought for \d+s$/);
});

test("thoughtContent collapsed is preview, expanded is page", () => {
  const collapsed = thoughtContent({
    expanded: false,
    preview: "alpha\nbeta\ngamma\ndelta",
    page: "book page one",
    width: 40,
    title: "Thought for 8s",
  });
  assert.equal(collapsed.title, "Thought for 8s");
  assert.match(collapsed.hint, /click to show more/);
  assert.ok(collapsed.body.includes("delta"));
  assert.equal(collapsed.body.includes("book page one"), false);
  const expanded = thoughtContent({
    expanded: true,
    preview: "alpha\nbeta\ngamma\ndelta",
    page: "book page one",
    width: 40,
    title: "Thought for 8s",
  });
  assert.equal(expanded.hint, "");
  assert.deepEqual(expanded.body, ["book page one"]);
});

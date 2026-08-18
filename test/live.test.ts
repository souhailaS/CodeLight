import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { EndOfLine, resetFake, TextDocument, Uri, workspace } from "./fakevscode";
import { buildAnchor } from "../src/anchors";
import { LiveRanges } from "../src/live";
import { Annotation } from "../src/model";
import { AnnotationStore } from "../src/store";

const SOURCE = ["export function total(cart) {", "  return cart.price * cart.count;", "}", ""].join(
  "\n"
);

const MARKED = "cart.price * cart.count";

let root = "";
let closing: Array<{ dispose(): void }> = [];

function positionOf(text: string, offset: number): { line: number; character: number } {
  const lines = text.slice(0, offset).split("\n");
  return { line: lines.length - 1, character: lines[lines.length - 1].length };
}

function highlight(id: string, text: string, marked: string): Annotation {
  const start = text.indexOf(marked);
  const end = start + marked.length;
  const from = positionOf(text, start);
  const to = positionOf(text, end);
  return {
    id,
    file: "src/a.ts",
    range: {
      startLine: from.line,
      startCharacter: from.character,
      endLine: to.line,
      endCharacter: to.character
    },
    anchor: buildAnchor(text, start, end),
    color: "yellow",
    author: { login: "ada", id: "42" },
    createdAt: "2026-08-17T09:12:33.000Z",
    updatedAt: "2026-08-17T09:12:33.000Z",
    comments: [],
    root: Uri.file(root).toString()
  };
}

async function open(text = SOURCE): Promise<{
  store: AnnotationStore;
  live: LiveRanges;
  document: TextDocument;
}> {
  const store = new AnnotationStore();
  await store.initialize();
  const document = new TextDocument(Uri.file(nodePath.join(root, "src/a.ts")), text);
  workspace.textDocuments = [document];
  const live = new LiveRanges(store);
  closing.push(live, store);
  return { store, live, document };
}

async function settle(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !check(); attempt += 1) {
    await new Promise((done) => setTimeout(done, 5));
  }
}

function span(live: LiveRanges, document: TextDocument, id: string): string {
  const spans = live.spansFor(document);
  const found = spans?.get(id);
  assert.ok(found, `no span for ${id}`);
  return document.getText().slice(found.start, found.end);
}

beforeEach(() => {
  resetFake();
  closing = [];
  root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "codelight-live-"));
  fs.mkdirSync(nodePath.join(root, ".vscode"));
  workspace.workspaceFolders = [{ uri: Uri.file(root), name: "root", index: 0 }];
});

afterEach(() => {
  for (const item of closing) {
    item.dispose();
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("a highlight while the file is edited", () => {
  it("keeps its text when a line is inserted above it", async () => {
    const { store, live, document } = await open();
    assert.ok(await store.add(highlight("one", SOURCE, MARKED)));
    assert.equal(span(live, document, "one"), MARKED);
    document.replace(0, 0, "// a note\n");
    assert.equal(span(live, document, "one"), MARKED);
  });

  it("keeps its text when characters are typed before it on the same line", async () => {
    const { store, live, document } = await open();
    assert.ok(await store.add(highlight("one", SOURCE, MARKED)));
    document.replace(SOURCE.indexOf("return"), 0, "/* keep */ ");
    assert.equal(span(live, document, "one"), MARKED);
  });

  it("grows when text is typed inside it", async () => {
    const { store, live, document } = await open();
    assert.ok(await store.add(highlight("one", SOURCE, MARKED)));
    document.replace(SOURCE.indexOf(" * cart.count"), 0, " * 2");
    assert.equal(span(live, document, "one"), "cart.price * 2 * cart.count");
  });

  it("shrinks when part of it is deleted", async () => {
    const { store, live, document } = await open();
    assert.ok(await store.add(highlight("one", SOURCE, MARKED)));
    document.replace(SOURCE.indexOf(" * cart.count"), " * cart.count".length, "");
    assert.equal(span(live, document, "one"), "cart.price");
  });

  it("collapses where the text was when all of it is deleted", async () => {
    const { store, live, document } = await open();
    assert.ok(await store.add(highlight("one", SOURCE, MARKED)));
    const at = SOURCE.indexOf(MARKED);
    document.replace(at, MARKED.length, "");
    const found = live.spansFor(document)?.get("one");
    assert.ok(found);
    assert.deepEqual(found, { start: at, end: at });
  });

  it("leaves a file no folder holds alone", async () => {
    const store = new AnnotationStore();
    await store.initialize();
    const outside = new TextDocument(Uri.file("/elsewhere/src/a.ts"), SOURCE);
    const live = new LiveRanges(store);
    closing.push(live, store);
    assert.equal(live.spansFor(outside), undefined);
  });

  it("seeds a file it never saw before the first edit", async () => {
    const { store, live } = await open();
    assert.ok(await store.add(highlight("one", SOURCE, MARKED)));
    const later = new TextDocument(Uri.file(nodePath.join(root, "src/a.ts")), SOURCE);
    later.replace(0, 0, "// a note\n");
    assert.equal(span(live, later, "one"), MARKED);
  });

  it("re-derives the spans when the line ending changes", async () => {
    const { store, live, document } = await open();
    assert.ok(await store.add(highlight("one", SOURCE, MARKED)));
    assert.equal(span(live, document, "one"), MARKED);
    const before = live.spansFor(document)?.get("one")?.start;
    document.useCrlf();
    assert.equal(document.eol, EndOfLine.CRLF);
    const after = live.spansFor(document)?.get("one");
    assert.ok(after);
    assert.notEqual(after.start, before);
    assert.equal(document.getText().slice(after.start, after.end), MARKED);
  });

  it("shifts every span of a single edit event", async () => {
    const { store, live, document } = await open();
    assert.ok(await store.add(highlight("one", SOURCE, MARKED)));
    assert.ok(await store.add(highlight("two", SOURCE, "cart.count")));
    document.edit([
      { start: 0, length: 0, text: "// a header\n" },
      { start: SOURCE.indexOf("  return"), length: 0, text: "  // and here\n" }
    ]);
    assert.equal(span(live, document, "one"), MARKED);
    assert.equal(span(live, document, "two"), "cart.count");
  });
});

describe("what a save writes back", () => {
  it("records where the text moved to", async () => {
    const { store, live, document } = await open();
    assert.ok(await store.add(highlight("one", SOURCE, MARKED)));
    document.replace(0, 0, "// a note\n");
    await live.flushDocument(document);
    const saved = store.byId("one");
    assert.ok(saved);
    assert.equal(saved.range.startLine, 2);
    assert.equal(saved.orphaned, undefined);
    const text = document.getText();
    const start = text.indexOf(MARKED);
    assert.equal(saved.range.startCharacter, start - text.lastIndexOf("\n", start) - 1);
  });

  it("writes nothing when the text did not move", async () => {
    const { store, live, document } = await open();
    assert.ok(await store.add(highlight("one", SOURCE, MARKED)));
    let wrote = 0;
    const listener = store.onDidChange(() => {
      wrote += 1;
    });
    await live.flushDocument(document);
    listener.dispose();
    assert.equal(wrote, 0);
    assert.equal(store.byId("one")?.orphaned, undefined);
  });

  it("writes back when the editor reports the file saved", async () => {
    const { store, live, document } = await open();
    assert.ok(await store.add(highlight("one", SOURCE, MARKED)));
    document.replace(0, 0, "// a note\n");
    await document.save();
    await settle(() => store.byId("one")?.range.startLine === 2);
    assert.equal(store.byId("one")?.range.startLine, 2);
    assert.equal(live.spansFor(document)?.get("one")?.start, document.getText().indexOf(MARKED));
  });

  it("marks the highlight orphaned once its text is gone", async () => {
    const { store, live, document } = await open();
    assert.ok(await store.add(highlight("one", SOURCE, MARKED)));
    const before = store.byId("one")?.range;
    document.replace(SOURCE.indexOf("  return"), "  return ".length, "");
    document.replace(document.getText().indexOf(MARKED), MARKED.length, "");
    await live.flushDocument(document);
    const saved = store.byId("one");
    assert.ok(saved);
    assert.equal(saved.orphaned, true);
    assert.notDeepEqual(saved.range, before);
    assert.equal(saved.range.startCharacter, 0);
  });

  it("takes the highlight back when the text is put back", async () => {
    const { store, live, document } = await open();
    assert.ok(await store.add(highlight("one", SOURCE, MARKED)));
    const at = SOURCE.indexOf(MARKED);
    document.replace(at, MARKED.length, "");
    await live.flushDocument(document);
    assert.equal(store.byId("one")?.orphaned, true);
    document.replace(at, 0, MARKED);
    await live.flushDocument(document);
    const saved = store.byId("one");
    assert.ok(saved);
    assert.equal(saved.orphaned, undefined);
    assert.equal(saved.range.startLine, 1);
    const text = document.getText();
    const lines = text.split("\n");
    assert.equal(
      lines[saved.range.startLine].slice(saved.range.startCharacter, saved.range.endCharacter),
      MARKED
    );
  });

  it("follows the text when the lines around it stay the same", async () => {
    const { store, live, document } = await open();
    assert.ok(await store.add(highlight("one", SOURCE, MARKED)));
    document.replace(0, 0, "// a header\n// and another\n");
    await live.flushDocument(document);
    const saved = store.byId("one");
    assert.ok(saved);
    assert.equal(saved.orphaned, undefined);
    assert.equal(saved.range.startLine, 3);
  });

  it("stays orphaned when the text comes back somewhere unrelated", async () => {
    const { store, live, document } = await open();
    assert.ok(await store.add(highlight("one", SOURCE, MARKED)));
    document.replace(SOURCE.indexOf(MARKED), MARKED.length, "");
    await live.flushDocument(document);
    document.replace(document.getText().length, 0, `const copy = ${MARKED};\n`);
    await live.flushDocument(document);
    assert.equal(store.byId("one")?.orphaned, true);
  });

  it("leaves an orphan alone while its text is still missing", async () => {
    const { store, live, document } = await open();
    assert.ok(await store.add(highlight("one", SOURCE, MARKED)));
    document.replace(SOURCE.indexOf(MARKED), MARKED.length, "");
    await live.flushDocument(document);
    const first = store.byId("one")?.range;
    await live.flushDocument(document);
    assert.equal(store.byId("one")?.orphaned, true);
    assert.deepEqual(store.byId("one")?.range, first);
  });

  it("rewrites the anchor so the next search follows the new surroundings", async () => {
    const { store, live, document } = await open();
    assert.ok(await store.add(highlight("one", SOURCE, MARKED)));
    const before = store.byId("one")?.anchor.before;
    document.replace(SOURCE.indexOf("  return"), "  return".length, "  return /* changed */");
    await live.flushDocument(document);
    const after = store.byId("one")?.anchor;
    assert.ok(after);
    assert.equal(after.text, MARKED);
    assert.notEqual(after.before, before);
    assert.ok(after.before.includes("changed"));
  });

  it("writes nothing for a file with no annotations", async () => {
    const { store, live, document } = await open();
    document.replace(0, 0, "// a note\n");
    await live.flushDocument(document);
    assert.deepEqual(store.all, []);
  });
});

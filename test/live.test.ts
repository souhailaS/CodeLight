import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { documentOpened, EndOfLine, resetFake, TextDocument, Uri, workspace } from "./fakevscode";
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

  it("collapses when all of its text is deleted", async () => {
    const { store, live, document } = await open();
    assert.ok(await store.add(highlight("one", SOURCE, MARKED)));
    document.replace(SOURCE.indexOf(MARKED), MARKED.length, "");
    assert.equal(span(live, document, "one"), "");
  });

  it("leaves a file no folder holds alone", async () => {
    const store = new AnnotationStore();
    await store.initialize();
    const outside = new TextDocument(Uri.file("/elsewhere/src/a.ts"), SOURCE);
    const live = new LiveRanges(store);
    closing.push(live, store);
    assert.equal(live.spansFor(outside), undefined);
  });

  it("picks up a file that opens after it started", async () => {
    const { store, live } = await open();
    assert.ok(await store.add(highlight("one", SOURCE, MARKED)));
    const later = new TextDocument(Uri.file(nodePath.join(root, "src/a.ts")), SOURCE);
    documentOpened.fire(later);
    assert.equal(span(live, later, "one"), MARKED);
  });

  it("re-derives the spans when the line ending changes", async () => {
    const { store, live, document } = await open();
    assert.ok(await store.add(highlight("one", SOURCE, MARKED)));
    assert.equal(span(live, document, "one"), MARKED);
    document.eol = EndOfLine.CRLF;
    document.isDirty = true;
    const before = live.spansFor(document)?.get("one");
    assert.ok(before);
    assert.equal(document.getText().slice(before.start, before.end), MARKED);
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
    const before = store.byId("one")?.updatedAt;
    await live.flushDocument(document);
    assert.equal(store.byId("one")?.updatedAt, before);
    assert.equal(store.byId("one")?.orphaned, undefined);
  });

  it("marks the highlight orphaned once its text is gone", async () => {
    const { store, live, document } = await open();
    assert.ok(await store.add(highlight("one", SOURCE, MARKED)));
    document.replace(SOURCE.indexOf(MARKED), MARKED.length, "");
    await live.flushDocument(document);
    assert.equal(store.byId("one")?.orphaned, true);
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

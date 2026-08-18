import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  Decoration,
  decorations,
  Editor,
  editorFor,
  Position,
  Range,
  resetFake,
  setFolderConfiguration,
  Uri,
  window,
  workspace
} from "./fakevscode";
import { Annotation } from "../src/model";
import { HighlightRenderer } from "../src/decorations";
import { LiveRanges } from "../src/live";
import { AnnotationStore } from "../src/store";
import { Visibility } from "../src/visibility";

let first = "";
let second = "";
let opened: Array<{ dispose(): void }> = [];

function folder(name: string): string {
  const created = fs.mkdtempSync(nodePath.join(os.tmpdir(), `codelight-${name}-`));
  fs.mkdirSync(nodePath.join(created, ".vscode"));
  return created;
}

async function renderer(): Promise<{
  store: AnnotationStore;
  live: LiveRanges;
  visibility: Visibility;
  view: HighlightRenderer;
}> {
  const store = new AnnotationStore();
  await store.initialize();
  const live = new LiveRanges(store);
  const visibility = new Visibility();
  const view = new HighlightRenderer(store, live, visibility);
  opened.push(view, live, visibility, store);
  return { store, live, visibility, view };
}

function alive(): number {
  return decorations.filter((type) => !type.disposed).length;
}

const SOURCE = "const total = one;\nconst other = two;\n";

function document(folder: string): unknown {
  const uri = Uri.file(nodePath.join(folder, "src/a.ts"));
  const lines = SOURCE.split("\n");
  return {
    uri,
    version: 1,
    isClosed: false,
    lineCount: lines.length,
    getText: () => SOURCE,
    offsetAt: (position: Position) =>
      lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) +
      position.character,
    positionAt: (offset: number) => {
      let left = offset;
      for (let line = 0; line < lines.length; line += 1) {
        if (left <= lines[line].length) {
          return new Position(line, left);
        }
        left -= lines[line].length + 1;
      }
      return new Position(lines.length - 1, 0);
    },
    lineAt: (line: number) => ({ range: new Range(line, 0, line, lines[line].length) }),
    validateRange: (range: Range) => range
  };
}

function annotation(id: string, folder: string, color: string): Annotation {
  return {
    id,
    file: "src/a.ts",
    range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 5 },
    anchor: { text: "const", before: "", after: " total = one;" },
    color,
    author: { login: "ada", id: "42" },
    createdAt: "2026-08-17T09:12:33.000Z",
    updatedAt: "2026-08-17T09:12:33.000Z",
    comments: [],
    root: Uri.file(folder).toString()
  };
}

function painted(editor: Editor): Decoration[] {
  return [...editor.applied].filter(([, ranges]) => ranges.length > 0).map(([type]) => type);
}

beforeEach(() => {
  resetFake();
  opened = [];
  first = folder("first");
  second = folder("second");
  workspace.workspaceFolders = [
    { uri: Uri.file(first), name: "first", index: 0 },
    { uri: Uri.file(second), name: "second", index: 1 }
  ];
});

afterEach(() => {
  for (const item of opened) {
    item.dispose();
  }
  fs.rmSync(first, { recursive: true, force: true });
  fs.rmSync(second, { recursive: true, force: true });
});

describe("the colours a folder defines", () => {
  it("offers the palette of the folder the file belongs to", async () => {
    setFolderConfiguration(Uri.file(second), "codelight.palette", [
      { id: "rust", label: "Rust", hex: "#b7410e" }
    ]);
    const { view } = await renderer();
    assert.deepEqual(
      view.colorsFor(Uri.file(nodePath.join(first, "src/a.ts"))).map((color) => color.id),
      ["yellow", "green", "blue", "purple", "pink", "orange"]
    );
    assert.deepEqual(
      view.colorsFor(Uri.file(nodePath.join(second, "src/a.ts"))).map((color) => color.id),
      ["rust"]
    );
  });

  it("reads a folder override for a file inside that folder", async () => {
    setFolderConfiguration(Uri.file(second), "codelight.palette", [
      { id: "rust", label: "Rust", hex: "#b7410e" }
    ]);
    const { view } = await renderer();
    assert.deepEqual(
      view.colorsFor(Uri.file(nodePath.join(second, "src/deep/nested/a.ts"))).map((color) => color.id),
      ["rust"]
    );
  });

  it("falls back to the shared palette for a file no folder holds", async () => {
    setFolderConfiguration(Uri.file(first), "codelight.palette", [
      { id: "rust", label: "Rust", hex: "#b7410e" }
    ]);
    const { view } = await renderer();
    assert.deepEqual(
      view.colorsFor(Uri.file("/elsewhere/a.ts")).map((color) => color.id),
      ["yellow", "green", "blue", "purple", "pink", "orange"]
    );
  });

  it("builds a decoration for each folder only once", async () => {
    setFolderConfiguration(Uri.file(second), "codelight.palette", [
      { id: "rust", label: "Rust", hex: "#b7410e" }
    ]);
    const { view } = await renderer();
    const start = alive();
    view.colorsFor(Uri.file(nodePath.join(second, "src/a.ts")));
    const built = alive();
    view.colorsFor(Uri.file(nodePath.join(second, "src/b.ts")));
    assert.ok(built > start);
    assert.equal(alive(), built);
  });

  it("lets the decorations of a folder go when it leaves the workspace", async () => {
    const { store, view } = await renderer();
    view.colorsFor(Uri.file(nodePath.join(second, "src/a.ts")));
    const built = alive();
    workspace.workspaceFolders = [{ uri: Uri.file(first), name: "first", index: 0 }];
    await store.initialize();
    assert.ok(alive() < built);
  });

  it("paints a file with the palette of its own folder", async () => {
    setFolderConfiguration(Uri.file(second), "codelight.palette", [
      { id: "rust", label: "Rust", hex: "#b7410e" }
    ]);
    const { store, view } = await renderer();
    assert.ok(await store.add(annotation("one", first, "yellow")));
    assert.ok(await store.add(annotation("two", second, "rust")));
    const here = editorFor(document(first));
    const there = editorFor(document(second));
    window.visibleTextEditors = [here, there];
    view.renderAll();
    assert.equal(painted(here).length, 2);
    assert.equal(painted(there).length, 2);
    assert.equal(painted(here).some((type) => painted(there).includes(type)), false);
  });

  it("honours the opacity of the folder the file belongs to", async () => {
    setFolderConfiguration(Uri.file(second), "codelight.highlightOpacity", 0.9);
    const { store, view } = await renderer();
    assert.ok(await store.add(annotation("one", first, "yellow")));
    assert.ok(await store.add(annotation("two", second, "yellow")));
    const here = editorFor(document(first));
    const there = editorFor(document(second));
    window.visibleTextEditors = [here, there];
    view.renderAll();
    const mine = painted(here)[0].options as { backgroundColor: string };
    const yours = painted(there)[0].options as { backgroundColor: string };
    assert.ok(mine.backgroundColor.endsWith("0.3)"), mine.backgroundColor);
    assert.ok(yours.backgroundColor.endsWith("0.9)"), yours.backgroundColor);
  });

  it("leaves out the gutter mark for a folder that turned it off", async () => {
    setFolderConfiguration(Uri.file(second), "codelight.gutterMarks", false);
    const { store, view } = await renderer();
    assert.ok(await store.add(annotation("one", first, "yellow")));
    assert.ok(await store.add(annotation("two", second, "yellow")));
    const here = editorFor(document(first));
    const there = editorFor(document(second));
    window.visibleTextEditors = [here, there];
    view.renderAll();
    assert.equal(painted(here).length, 2);
    assert.equal(painted(there).length, 1);
  });

  it("clears the decorations of the folder a file no longer belongs to", async () => {
    const inner = nodePath.join(first, "packages", "inner");
    fs.mkdirSync(nodePath.join(inner, ".vscode"), { recursive: true });
    const { store, view } = await renderer();
    const entry = annotation("one", first, "yellow");
    entry.file = "packages/inner/src/a.ts";
    assert.ok(await store.add(entry));
    const editor = editorFor(document(nodePath.join(first, "packages", "inner")));
    window.visibleTextEditors = [editor];
    view.renderAll();
    const before = painted(editor);
    assert.ok(before.length > 0);
    workspace.workspaceFolders = [
      { uri: Uri.file(first), name: "first", index: 0 },
      { uri: Uri.file(second), name: "second", index: 1 },
      { uri: Uri.file(inner), name: "inner", index: 2 }
    ];
    await store.initialize();
    view.renderAll();
    for (const type of before) {
      assert.deepEqual(editor.applied.get(type), []);
    }
  });

  it("paints nothing for a highlight it cannot place in this version of the file", async () => {
    const { store, view } = await renderer();
    assert.ok(await store.add(annotation("one", first, "yellow")));
    const changed = document(first) as { getText(): string };
    const editor = editorFor({
      ...changed,
      getText: () => "let nothing = here;\nlet other = two;\n"
    });
    window.visibleTextEditors = [editor];
    view.renderAll();
    assert.deepEqual(painted(editor), []);
  });

  it("obeys the inline comment mode of each folder", async () => {
    setFolderConfiguration(Uri.file(second), "codelight.inlineComments", "off");
    const { store, view } = await renderer();
    const mine = annotation("one", first, "yellow");
    mine.comments = [
      {
        id: "c1",
        author: { login: "ada", id: "42" },
        body: "worth a look",
        createdAt: "2026-08-17T09:12:33.000Z",
        updatedAt: "2026-08-17T09:12:33.000Z"
      }
    ];
    const yours = { ...mine, id: "two", root: Uri.file(second).toString() };
    assert.ok(await store.add(mine));
    assert.ok(await store.add(yours));
    const here = editorFor(document(first));
    const there = editorFor(document(second));
    window.visibleTextEditors = [here, there];
    view.renderAll();
    const badge = decorations.find(
      (type) => (type.options as { after?: unknown }).after !== undefined
    );
    assert.ok(badge);
    assert.equal((here.applied.get(badge) ?? []).length, 1);
    assert.equal((there.applied.get(badge) ?? []).length, 0);
  });

  it("makes nothing new once it is disposed", async () => {
    const { store, view } = await renderer();
    assert.ok(await store.add(annotation("one", first, "yellow")));
    const editor = editorFor(document(first));
    window.visibleTextEditors = [editor];
    view.renderAll();
    assert.ok(painted(editor).length > 0);
    editor.applied.clear();
    view.dispose();
    assert.equal(alive(), 0);
    assert.deepEqual(view.colorsFor(Uri.file(nodePath.join(second, "src/a.ts"))), []);
    view.renderAll();
    assert.equal(alive(), 0);
    assert.deepEqual([...editor.applied.keys()], []);
  });

  it("disposes every decoration it made", async () => {
    const { view } = await renderer();
    view.colorsFor(Uri.file(nodePath.join(first, "src/a.ts")));
    view.colorsFor(Uri.file(nodePath.join(second, "src/a.ts")));
    assert.ok(alive() > 0);
    view.dispose();
    assert.equal(alive(), 0);
  });
});

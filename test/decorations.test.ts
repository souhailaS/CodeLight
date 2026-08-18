import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { decorations, resetFake, setFolderConfiguration, Uri, workspace } from "./fakevscode";
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

  it("disposes every decoration it made", async () => {
    const { view } = await renderer();
    view.colorsFor(Uri.file(nodePath.join(first, "src/a.ts")));
    view.colorsFor(Uri.file(nodePath.join(second, "src/a.ts")));
    assert.ok(alive() > 0);
    view.dispose();
    assert.equal(alive(), 0);
  });
});

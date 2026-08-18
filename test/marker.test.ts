import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  authentication,
  editorFor,
  Editor,
  editorSelectionChanged,
  faults,
  invoked,
  messages,
  Position,
  queuePick,
  Range,
  resetFake,
  setFolderConfiguration,
  statusBars,
  TextDocument,
  TextEditorSelectionChangeKind,
  Uri,
  warnings,
  window,
  workspace
} from "./fakevscode";
import { HighlightRenderer } from "../src/decorations";
import { HighlightCommands, useSwatches } from "../src/highlights";
import { IdentityProvider } from "../src/identity";
import { LiveRanges } from "../src/live";
import { MarkerMode } from "../src/marker";
import { AnnotationStore } from "../src/store";
import { Swatches } from "../src/swatches";
import { Visibility } from "../src/visibility";

const SOURCE = ["const total = one + two;", "const other = three + four;", ""].join("\n");

let root = "";
let closing: Array<{ dispose(): void }> = [];

interface Rig {
  store: AnnotationStore;
  marker: MarkerMode;
  editor: Editor;
  document: TextDocument;
}

function select(document: TextDocument, from: number, to: number): Range {
  return new Range(document.positionAt(from), document.positionAt(to));
}

function drive(editor: Editor, ranges: Range[], kind = TextEditorSelectionChangeKind.Mouse): void {
  (editor as unknown as { selections: Range[] }).selections = ranges;
  editorSelectionChanged.fire({ textEditor: editor, selections: ranges, kind });
}

async function settle(check: () => boolean, limit = 300): Promise<void> {
  for (let attempt = 0; attempt < limit && !check(); attempt += 1) {
    await new Promise((done) => setTimeout(done, 10));
  }
}

function shape(store: AnnotationStore): string {
  return JSON.stringify(
    store.all.map((entry) => [entry.anchor.text, entry.color, entry.comments.length]).sort()
  );
}

async function reach(store: AnnotationStore, wanted: Array<Array<string | number>>): Promise<void> {
  const target = JSON.stringify([...wanted].sort());
  for (let attempt = 0; attempt < 600 && shape(store) !== target; attempt += 1) {
    await new Promise((done) => setTimeout(done, 10));
  }
  await quiet(store);
}

async function quiet(store: AnnotationStore): Promise<void> {
  let seen = "";
  let steady = 0;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    await new Promise((done) => setTimeout(done, 10));
    const now = shape(store);
    steady = now === seen ? steady + 1 : 0;
    seen = now;
    if (attempt > 90 && steady > 30) {
      return;
    }
  }
}

async function rig(): Promise<Rig> {
  const store = new AnnotationStore();
  await store.initialize();
  const live = new LiveRanges(store);
  const visibility = new Visibility();
  const renderer = new HighlightRenderer(store, live, visibility);
  const identity = new IdentityProvider();
  useSwatches(new Swatches(Uri.file(nodePath.join(root, "storage"))));
  const highlights = new HighlightCommands(store, identity, renderer, live, visibility);
  const marker = new MarkerMode(identity, store, renderer, highlights, live, visibility);
  const document = new TextDocument(Uri.file(nodePath.join(root, "src/a.ts")), SOURCE);
  workspace.textDocuments = [document];
  const editor = editorFor(document);
  (editor as unknown as { selections: Range[] }).selections = [];
  window.activeTextEditor = editor;
  window.visibleTextEditors = [editor];
  closing.push(marker, renderer, live, visibility, identity, store);
  return { store, marker, editor, document };
}

async function turnOn(marker: MarkerMode, at = 0): Promise<void> {
  queuePick(at);
  await marker.toggle();
}

beforeEach(() => {
  resetFake();
  closing = [];
  root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "codelight-marker-"));
  fs.mkdirSync(nodePath.join(root, ".vscode"));
  workspace.workspaceFolders = [{ uri: Uri.file(root), name: "root", index: 0 }];
  authentication.session = { account: { label: "ada", id: "42" }, accessToken: "t" };
});

afterEach(() => {
  for (const item of closing) {
    item.dispose();
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("turning the marker on", () => {
  it("shows the colour it will use in the status bar", async () => {
    const { marker } = await rig();
    await turnOn(marker);
    assert.ok(marker.active);
    const bar = statusBars[statusBars.length - 1];
    assert.ok(bar.visible);
    assert.ok(bar.text.includes("Yellow"));
    assert.equal(bar.command, "codelight.markerOff");
    assert.ok(invoked.some((call) => call[1] === "codelight.marker" && call[2] === true));
  });

  it("stays off when no colour is picked", async () => {
    const { marker } = await rig();
    await marker.toggle();
    assert.equal(marker.active, false);
    assert.equal(statusBars[statusBars.length - 1].visible, false);
  });

  it("refuses a file that no folder holds", async () => {
    const { marker } = await rig();
    const outside = new TextDocument(Uri.file("/elsewhere/a.ts"), SOURCE);
    window.activeTextEditor = editorFor(outside);
    await turnOn(marker);
    assert.equal(marker.active, false);
    assert.ok(warnings().some((entry) => entry.includes("folder of this workspace")));
  });

  it("stays off when nobody is signed in", async () => {
    authentication.session = undefined;
    const { marker } = await rig();
    await turnOn(marker);
    assert.equal(marker.active, false);
  });

  it("turns itself off the second time", async () => {
    const { marker } = await rig();
    await turnOn(marker);
    await marker.toggle();
    assert.equal(marker.active, false);
    assert.equal(statusBars[statusBars.length - 1].visible, false);
    assert.ok(invoked.some((call) => call[1] === "codelight.marker" && call[2] === false));
  });
});

describe("marking while it is on", () => {
  it("highlights what the user selected once the selection settles", async () => {
    const { store, marker, editor, document } = await rig();
    await turnOn(marker);
    drive(editor, [select(document, 6, 11)]);
    await settle(() => store.all.length === 1);
    assert.equal(store.all.length, 1);
    assert.equal(store.all[0].anchor.text, "total");
    assert.equal(store.all[0].color, "yellow");
    assert.equal(store.all[0].author.login, "ada");
  });

  it("marks every selection of a multi cursor edit", async () => {
    const { store, marker, editor, document } = await rig();
    await turnOn(marker);
    drive(editor, [select(document, 6, 11), select(document, 31, 36)]);
    await settle(() => store.all.length === 2);
    assert.deepEqual(
      store.all.map((entry) => entry.anchor.text).sort(),
      ["other", "total"]
    );
  });

  it("waits for the selection to stop growing", async () => {
    const { store, marker, editor, document } = await rig();
    await turnOn(marker);
    drive(editor, [select(document, 6, 8)]);
    drive(editor, [select(document, 6, 11)]);
    await settle(() => store.all.length === 1);
    assert.equal(store.all.length, 1);
    assert.equal(store.all[0].anchor.text, "total");
  });

  it("replaces its own highlight when the selection grows past it", async () => {
    const { store, marker, editor, document } = await rig();
    await turnOn(marker);
    drive(editor, [select(document, 6, 11)]);
    await settle(() => store.all.length === 1);
    drive(editor, [select(document, 6, 17)]);
    await reach(store, [["total = one", "yellow", 0]]);
    assert.equal(store.all.length, 1);
    assert.equal(store.all[0].anchor.text, "total = one");
  });

  it("keeps a highlight that carries a comment when the selection grows", async () => {
    const { store, marker, editor, document } = await rig();
    await turnOn(marker);
    drive(editor, [select(document, 6, 11)]);
    await settle(() => store.all.length === 1);
    const first = store.all[0].id;
    assert.ok(
      await store.update(first, (current) => ({
        ...current,
        comments: [
          {
            id: "c1",
            author: { login: "ada", id: "42" },
            body: "keep me",
            createdAt: "t",
            updatedAt: "t"
          }
        ]
      }))
    );
    drive(editor, [select(document, 6, 17)]);
    await reach(store, [
      ["total", "yellow", 1],
      ["total = one", "yellow", 0]
    ]);
    assert.equal(store.all.length, 2);
    assert.ok(store.byId(first));
    assert.equal(store.byId(first)?.comments.length, 1);
  });

  it("will not recolour a highlight that carries a comment", async () => {
    const { store, marker, editor, document } = await rig();
    await turnOn(marker);
    drive(editor, [select(document, 6, 11)]);
    await settle(() => store.all.length === 1);
    const first = store.all[0].id;
    assert.ok(
      await store.update(first, (current) => ({
        ...current,
        comments: [
          {
            id: "c1",
            author: { login: "ada", id: "42" },
            body: "keep me",
            createdAt: "t",
            updatedAt: "t"
          }
        ]
      }))
    );
    await marker.toggle();
    queuePick(1);
    await marker.toggle();
    drive(editor, [select(document, 6, 11)]);
    await reach(store, [["total", "yellow", 1]]);
    assert.equal(store.all.length, 1);
    assert.equal(store.byId(first)?.color, "yellow");
    assert.equal(store.byId(first)?.comments.length, 1);
  });

  it("recolours its own highlight instead of stacking a second one", async () => {
    const { store, marker, editor, document } = await rig();
    await turnOn(marker);
    drive(editor, [select(document, 6, 11)]);
    await settle(() => store.all.length === 1);
    const first = store.all[0].id;
    await marker.toggle();
    queuePick(1);
    await marker.toggle();
    drive(editor, [select(document, 6, 11)]);
    await reach(store, [["total", "green", 0]]);
    assert.equal(store.all.length, 1);
    assert.equal(store.byId(first)?.color, "green");
  });

  it("ignores a selection made by a command rather than the user", async () => {
    const { store, marker, editor, document } = await rig();
    await turnOn(marker);
    drive(editor, [select(document, 6, 11)], TextEditorSelectionChangeKind.Command);
    await settle(() => store.all.length > 0, 80);
    assert.deepEqual(store.all, []);
  });

  it("ignores an empty selection", async () => {
    const { store, marker, editor, document } = await rig();
    await turnOn(marker);
    drive(editor, [select(document, 6, 6)]);
    await settle(() => store.all.length > 0, 80);
    assert.deepEqual(store.all, []);
  });

  it("marks nothing while it is off", async () => {
    const { store, marker, editor, document } = await rig();
    drive(editor, [select(document, 6, 11)]);
    await settle(() => store.all.length > 0, 80);
    assert.deepEqual(store.all, []);
    assert.equal(marker.active, false);
  });

  it("drops a pending mark when the editor changes", async () => {
    const { store, marker, editor, document } = await rig();
    await turnOn(marker);
    drive(editor, [select(document, 6, 11)]);
    window.activeTextEditor = undefined;
    (window as unknown as { activeTextEditor: unknown }).activeTextEditor = undefined;
    await settle(() => store.all.length > 0, 80);
    assert.deepEqual(store.all, []);
  });
});

describe("what the marker does under pressure", () => {
  it("keeps a highlight the user finished with when the save was slow", async () => {
    const { store, marker, editor, document } = await rig();
    await turnOn(marker);
    faults.writeDelayMs = 900;
    drive(editor, [select(document, 6, 11)]);
    await new Promise((done) => setTimeout(done, 700));
    drive(editor, [select(document, 6, 6)]);
    await settle(() => store.all.length === 1, 400);
    faults.writeDelayMs = 0;
    drive(editor, [select(document, 6, 17)]);
    await reach(store, [
      ["total", "yellow", 0],
      ["total = one", "yellow", 0]
    ]);
    assert.deepEqual(
      store.all.map((entry) => entry.anchor.text).sort(),
      ["total", "total = one"]
    );
  });

  it("keeps the chain after it recoloured one of its own", async () => {
    const { store, marker, editor, document } = await rig();
    await turnOn(marker);
    drive(editor, [select(document, 6, 11)]);
    await settle(() => store.all.length === 1);
    drive(editor, [select(document, 6, 11)]);
    await quiet(store);
    drive(editor, [select(document, 6, 17)]);
    await reach(store, [["total = one", "yellow", 0]]);
    assert.equal(store.all.length, 1);
    assert.equal(store.all[0].anchor.text, "total = one");
  });

  it("recolours a highlight the outer folder owns", async () => {
    const inner = nodePath.join(root, "packages", "inner");
    fs.mkdirSync(nodePath.join(inner, ".vscode"), { recursive: true });
    workspace.workspaceFolders = [
      { uri: Uri.file(root), name: "root", index: 0 },
      { uri: Uri.file(inner), name: "inner", index: 1 }
    ];
    const { store, marker } = await rig();
    const nested = new TextDocument(Uri.file(nodePath.join(inner, "src/a.ts")), SOURCE);
    workspace.textDocuments = [nested];
    const there = editorFor(nested);
    (there as unknown as { selections: Range[] }).selections = [];
    window.activeTextEditor = there;
    window.visibleTextEditors = [there];
    assert.ok(
      await store.add({
        id: "outer",
        file: "packages/inner/src/a.ts",
        range: { startLine: 0, startCharacter: 6, endLine: 0, endCharacter: 11 },
        anchor: { text: "total", before: "const ", after: " = one" },
        color: "green",
        author: { login: "ada", id: "42" },
        createdAt: "t",
        updatedAt: "t",
        comments: [],
        root: Uri.file(root).toString()
      })
    );
    await turnOn(marker);
    messages.length = 0;
    drive(there, [select(nested, 6, 11)]);
    await reach(store, [["total", "yellow", 0]]);
    assert.equal(store.all.length, 1);
    assert.equal(store.byId("outer")?.color, "yellow");
    assert.deepEqual(warnings(), []);
  });

  it("stops when the folder it moved to has no such colour", async () => {
    const second = fs.mkdtempSync(nodePath.join(os.tmpdir(), "codelight-other-"));
    fs.mkdirSync(nodePath.join(second, ".vscode"));
    workspace.workspaceFolders = [
      { uri: Uri.file(root), name: "root", index: 0 },
      { uri: Uri.file(second), name: "second", index: 1 }
    ];
    setFolderConfiguration(Uri.file(second), "codelight.palette", [
      { id: "rust", label: "Rust", hex: "#b7410e" }
    ]);
    const { store, marker } = await rig();
    await turnOn(marker);
    const other = new TextDocument(Uri.file(nodePath.join(second, "src/b.ts")), SOURCE);
    workspace.textDocuments = [other];
    const there = editorFor(other);
    (there as unknown as { selections: Range[] }).selections = [];
    window.activeTextEditor = there;
    messages.length = 0;
    drive(there, [select(other, 6, 11)]);
    await settle(() => !marker.active, 400);
    await quiet(store);
    assert.deepEqual(store.all, []);
    assert.equal(marker.active, false);
    assert.ok(warnings().some((entry) => entry.includes("palette of this folder")));
    fs.rmSync(second, { recursive: true, force: true });
  });

  it("says nothing when a selection lands on text it cannot mark", async () => {
    const { store, marker, editor, document } = await rig();
    await turnOn(marker);
    drive(editor, [select(document, 6, 11)]);
    await settle(() => store.all.length === 1);
    assert.ok(
      await store.update(store.all[0].id, (current) => ({
        ...current,
        author: { login: "someone", id: "99" }
      }))
    );
    messages.length = 0;
    drive(editor, [select(document, 6, 11)]);
    await quiet(store);
    assert.equal(store.all.length, 1);
    assert.deepEqual(warnings(), []);
  });
});

describe("turning the marker off", () => {
  it("stops when the notes are hidden", async () => {
    const { marker } = await rig();
    const visibility = closing.find((item) => item instanceof Visibility) as Visibility;
    await turnOn(marker);
    visibility.toggle();
    assert.equal(marker.active, false);
  });

  it("keeps what it already marked", async () => {
    const { store, marker, editor, document } = await rig();
    await turnOn(marker);
    drive(editor, [select(document, 6, 11)]);
    await settle(() => store.all.length === 1);
    marker.off();
    assert.equal(marker.active, false);
    assert.equal(store.all.length, 1);
  });

  it("lets the status bar go when it is disposed", async () => {
    const { marker } = await rig();
    await turnOn(marker);
    const bar = statusBars[statusBars.length - 1];
    marker.dispose();
    assert.ok(bar.disposed);
  });
});

describe("the position helpers the marker leans on", () => {
  it("maps an offset to the line and character the editor would show", async () => {
    const { document } = await rig();
    assert.deepEqual(document.positionAt(6), new Position(0, 6));
    assert.deepEqual(document.positionAt(25), new Position(1, 0));
    assert.equal(document.offsetAt(new Position(1, 6)), 31);
  });

  it("says nothing was marked when the document has no selection", async () => {
    const { editor } = await rig();
    assert.deepEqual((editor as unknown as { selections: Range[] }).selections, []);
    assert.deepEqual(messages, []);
  });
});

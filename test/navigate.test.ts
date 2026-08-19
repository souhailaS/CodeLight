import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  messages,
  opened,
  Position,
  Range,
  resetFake,
  Selection,
  shown,
  TextDocument,
  Uri,
  window,
  workspace
} from "./fakevscode";
import { LiveRanges } from "../src/live";
import { Annotation, Comment } from "../src/model";
import { Navigation } from "../src/navigate";
import { Visibility } from "../src/visibility";
import { AnnotationStore } from "../src/store";

const body = ["const one = 1;", "const two = 2;", "const three = 3;", ""].join("\n");

let root = "";
let closing: Array<{ dispose(): void }> = [];

function comment(id: string): Comment {
  return {
    id,
    author: { login: "ada", id: "42" },
    body: "worth a look",
    createdAt: "2026-08-17T09:12:33.000Z",
    updatedAt: "2026-08-17T09:12:33.000Z"
  };
}

function annotation(id: string, line: number, text: string, extra: Partial<Annotation> = {}): Annotation {
  return {
    id,
    file: "src/a.ts",
    range: { startLine: line, startCharacter: 6, endLine: line, endCharacter: 6 + text.length },
    anchor: { text, before: "const ", after: " =" },
    color: "yellow",
    author: { login: "ada", id: "42" },
    createdAt: "2026-08-17T09:12:33.000Z",
    updatedAt: "2026-08-17T09:12:33.000Z",
    comments: [],
    root: Uri.file(root).toString(),
    ...extra
  };
}

async function rig(entries: Annotation[], text = body) {
  const store = new AnnotationStore();
  await store.initialize();
  for (const entry of entries) {
    assert.ok(await store.add(entry));
  }
  const document = new TextDocument(Uri.file(nodePath.join(root, "src/a.ts")), text);
  workspace.textDocuments = [document];
  const live = new LiveRanges(store);
  let held = [new Selection(new Position(0, 0), new Position(0, 0))];
  const editor = {
    document,
    revealed: undefined as unknown,
    get selection(): Selection {
      return held[0];
    },
    set selection(value: Selection) {
      held = [value];
    },
    get selections(): Selection[] {
      return held;
    },
    set selections(value: Selection[]) {
      held = value;
    },
    revealRange(range: unknown) {
      editor.revealed = range;
    }
  };
  (window as { activeTextEditor: unknown }).activeTextEditor = editor;
  const visibility = new Visibility();
  closing.push(live, store, visibility);
  return { store, live, editor, visibility, navigation: new Navigation(store, live, visibility) };
}

function cursor(editor: { selection: Selection }, line: number, character: number): void {
  editor.selection = new Selection(new Position(line, character), new Position(line, character));
}

function status(): string {
  return messages.filter((entry) => entry.startsWith("status ")).pop() ?? "";
}

beforeEach(() => {
  resetFake();
  closing = [];
  root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "codelight-nav-"));
  fs.mkdirSync(nodePath.join(root, ".vscode"));
  workspace.workspaceFolders = [{ uri: Uri.file(root), name: "root", index: 0 }];
});

afterEach(() => {
  for (const item of closing) {
    item.dispose();
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("stepping through the highlights of a file", () => {
  it("goes to the first highlight after the cursor", async () => {
    const { navigation, editor } = await rig([annotation("a", 0, "one"), annotation("b", 2, "three")]);
    assert.equal(await navigation.step(true), true);
    assert.equal(editor.selection.start.line, 0);
    assert.equal(editor.selection.start.character, 6);
    assert.equal(editor.selection.isEmpty, true);
    assert.equal((editor.revealed as Range).end.character, 9);
  });

  it("takes the highlights in the order they sit in the file, not the order they were written", async () => {
    const { navigation, editor } = await rig([annotation("late", 2, "three"), annotation("early", 0, "one")]);
    await navigation.step(true);
    assert.equal(editor.selection.start.line, 0);
    await navigation.step(true);
    assert.equal(editor.selection.start.line, 2);
  });

  it("wraps to the first one and says so once past the last", async () => {
    const { navigation, editor } = await rig([annotation("a", 0, "one"), annotation("b", 2, "three")]);
    cursor(editor, 2, 10);
    assert.equal(await navigation.step(true), true);
    assert.equal(editor.selection.start.line, 0);
    assert.ok(messages.some((entry) => entry.includes("back around")), messages.join("|"));
  });

  it("walks backwards and wraps to the last one", async () => {
    const { navigation, editor } = await rig([annotation("a", 0, "one"), annotation("b", 2, "three")]);
    cursor(editor, 1, 0);
    assert.equal(await navigation.step(false), true);
    assert.equal(editor.selection.start.line, 0);
    cursor(editor, 0, 0);
    assert.equal(await navigation.step(false), true);
    assert.equal(editor.selection.start.line, 2);
  });

  it("moves off a highlight the cursor already sits on", async () => {
    const { navigation, editor } = await rig([annotation("a", 0, "one"), annotation("b", 2, "three")]);
    cursor(editor, 0, 6);
    assert.equal(await navigation.step(true), true);
    assert.equal(editor.selection.start.line, 2);
    cursor(editor, 2, 6);
    assert.equal(await navigation.step(false), true);
    assert.equal(editor.selection.start.line, 0);
  });

  it("keeps stepping forward and back without getting stuck", async () => {
    const { navigation, editor } = await rig([
      annotation("a", 0, "one"),
      annotation("b", 2, "three")
    ]);
    await navigation.step(true);
    assert.equal(editor.selection.start.line, 0);
    await navigation.step(true);
    assert.equal(editor.selection.start.line, 2);
    await navigation.step(false);
    assert.equal(editor.selection.start.line, 0);
    await navigation.step(false);
    assert.equal(editor.selection.start.line, 2);
  });

  it("reaches a highlight that starts where the cursor already is", async () => {
    const { navigation, editor } = await rig([
      annotation("a", 0, "one"),
      annotation("b", 2, "three")
    ]);
    cursor(editor, 0, 0);
    await navigation.step(true);
    assert.equal(editor.selection.start.line, 0);
    assert.equal(status().includes("back around"), false, status());
  });

  it("reaches both of two highlights that start together", async () => {
    const outer = annotation("outer", 1, "two = 2");
    const inner = annotation("inner", 1, "two");
    const { navigation } = await rig([outer, inner]);
    const seen: string[] = [];
    for (let step = 0; step < 3; step += 1) {
      await navigation.step(true);
      seen.push(status());
    }
    assert.ok(seen[0].includes("Highlight 1 of 2"), seen.join("|"));
    assert.ok(seen[1].includes("Highlight 2 of 2"), seen.join("|"));
    assert.ok(seen[2].includes("Highlight 1 of 2"), seen.join("|"));
  });

  it("leaves one cursor behind, not a selection over the code", async () => {
    const { navigation, editor } = await rig([annotation("a", 0, "one")]);
    editor.selections = [
      new Selection(new Position(0, 0), new Position(0, 0)),
      new Selection(new Position(1, 0), new Position(1, 0))
    ];
    await navigation.step(true);
    assert.equal(editor.selections.length, 1);
    assert.equal(editor.selection.isEmpty, true);
    assert.equal(editor.selection.start.character, 6);
  });

  it("counts the highlights it had to leave out", async () => {
    const { navigation } = await rig([annotation("gone", 0, "missing"), annotation("here", 2, "three")]);
    await navigation.step(true);
    assert.ok(status().includes("Highlight 1 of 1"), status());
    assert.ok(status().includes("1 not in this version"), status());
  });

  it("says the notes are hidden when they are", async () => {
    const { navigation, visibility } = await rig([annotation("a", 0, "one")]);
    visibility.toggle();
    await navigation.step(true);
    assert.ok(status().includes("notes hidden"), status());
  });

  it("says where you are and what the highlight carries", async () => {
    const { navigation } = await rig([
      annotation("a", 0, "one", { comments: [comment("c1")] }),
      annotation("b", 2, "three")
    ]);
    await navigation.step(true);
    assert.ok(
      messages.some((entry) => entry.includes("Highlight 1 of 2") && entry.includes("1 comment")),
      messages.join("|")
    );
  });

  it("does not claim a wrap when the file holds one highlight", async () => {
    const { navigation, editor } = await rig([annotation("a", 0, "one")]);
    cursor(editor, 2, 0);
    await navigation.step(true);
    assert.equal(
      messages.some((entry) => entry.includes("back around")),
      false
    );
  });

  it("follows an edit rather than the offsets on disk", async () => {
    const { navigation, editor } = await rig(
      [annotation("a", 2, "three")],
      ["added", body].join("\n")
    );
    await navigation.step(true);
    assert.equal(editor.selection.start.line, 3);
  });

  it("skips a highlight this version of the file cannot place", async () => {
    const { navigation, editor } = await rig(
      [annotation("gone", 0, "missing"), annotation("here", 2, "three")],
      body
    );
    assert.equal(await navigation.step(true), true);
    assert.equal(editor.selection.start.line, 2);
  });

  it("says nothing can be reached when every highlight is unplaceable", async () => {
    const { navigation } = await rig([annotation("gone", 0, "missing"), annotation("also", 1, "absent")]);
    assert.equal(await navigation.step(true), false);
    assert.ok(
      messages.some((entry) => entry.startsWith("warning All 2 highlights")),
      messages.join("|")
    );
  });

  it("says the file has none rather than moving the cursor", async () => {
    const { navigation, editor } = await rig([]);
    cursor(editor, 1, 3);
    assert.equal(await navigation.step(true), false);
    assert.equal(editor.selection.start.line, 1);
    assert.ok(messages.some((entry) => entry.includes("no highlights")), messages.join("|"));
  });

  it("opens the file it steps in when the editor is not the active tab", async () => {
    const { navigation, editor } = await rig([annotation("a", 0, "one")]);
    (window as { activeTextEditor: unknown }).activeTextEditor = undefined;
    window.visibleTextEditors = [editor as never];
    assert.equal(await navigation.step(true), true);
    assert.equal(opened.length, 1);
    const focused = shown[shown.length - 1] as { selections: Selection[] };
    assert.equal(focused.selections[0].start.line, 0);
    assert.equal(focused.selections[0].start.character, 6);
  });

  it("reads the file once for a run of steps, and again once a note changes", async () => {
    const { navigation, live, store } = await rig([
      annotation("a", 0, "one"),
      annotation("b", 2, "three")
    ]);
    let reads = 0;
    const placed = live.placedIn.bind(live);
    (live as unknown as { placedIn: typeof placed }).placedIn = (document) => {
      reads += 1;
      return placed(document);
    };
    await navigation.step(true);
    await navigation.step(true);
    await navigation.step(false);
    assert.equal(reads, 1);
    assert.ok(await store.remove("b"));
    await navigation.step(true);
    assert.equal(reads, 2);
  });

  it("says to open a file when none is open", async () => {
    const { navigation } = await rig([annotation("a", 0, "one")]);
    (window as { activeTextEditor: unknown }).activeTextEditor = undefined;
    assert.equal(await navigation.step(true), false);
    assert.ok(messages.some((entry) => entry.includes("Open a file")), messages.join("|"));
  });
});

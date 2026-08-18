import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resetFake, statusBars, TextDocument, Uri, window, workspace } from "./fakevscode";
import { Annotation, Comment } from "../src/model";
import { FileStatus } from "../src/statusbar";
import { AnnotationStore } from "../src/store";
import { Visibility } from "../src/visibility";

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

function annotation(id: string, comments: Comment[], orphaned = false): Annotation {
  return {
    id,
    file: "src/a.ts",
    range: { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 5 },
    anchor: { text: "const", before: "", after: "" },
    color: "yellow",
    author: { login: "ada", id: "42" },
    createdAt: "2026-08-17T09:12:33.000Z",
    updatedAt: "2026-08-17T09:12:33.000Z",
    comments,
    orphaned: orphaned ? true : undefined,
    root: Uri.file(root).toString()
  };
}

async function bar(entries: Annotation[], open = true): Promise<{ text: string; tooltip: string; visible: boolean }> {
  const store = new AnnotationStore();
  await store.initialize();
  for (const entry of entries) {
    assert.ok(await store.add(entry));
  }
  const visibility = new Visibility();
  const document = new TextDocument(Uri.file(nodePath.join(root, "src/a.ts")), "const one = 1;\n");
  workspace.textDocuments = [document];
  (window as { activeTextEditor: unknown }).activeTextEditor = open ? { document } : undefined;
  const status = new FileStatus(store, visibility);
  closing.push(status, visibility, store);
  const item = statusBars[statusBars.length - 1];
  return { text: item.text, tooltip: item.tooltip, visible: item.visible };
}

beforeEach(() => {
  resetFake();
  closing = [];
  root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "codelight-status-"));
  fs.mkdirSync(nodePath.join(root, ".vscode"));
  workspace.workspaceFolders = [{ uri: Uri.file(root), name: "root", index: 0 }];
});

afterEach(() => {
  for (const item of closing) {
    item.dispose();
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("what the status bar counts", () => {
  it("stays away when the file has no notes", async () => {
    const shown = await bar([]);
    assert.equal(shown.visible, false);
  });

  it("stays away when no file is open", async () => {
    const shown = await bar([annotation("one", [])], false);
    assert.equal(shown.visible, false);
  });

  it("counts one highlight with no comment", async () => {
    const shown = await bar([annotation("one", [])]);
    assert.ok(shown.visible);
    assert.ok(shown.text.includes("1 highlight"));
    assert.equal(shown.text.includes(","), false);
    assert.ok(shown.tooltip.includes("1 highlight in this file"));
  });

  it("counts the comments beside the highlights", async () => {
    const shown = await bar([
      annotation("one", [comment("c1"), comment("c2")]),
      annotation("two", [comment("c3")])
    ]);
    assert.ok(shown.text.includes("2 highlights, 3"));
    assert.ok(shown.tooltip.includes("2 highlights and 3 comments"));
  });

  it("counts the comments a stranded highlight still carries", async () => {
    const shown = await bar([
      annotation("one", [comment("c1")]),
      annotation("two", [comment("c2"), comment("c3")], true)
    ]);
    assert.ok(shown.text.includes("1 highlight, 3"), shown.text);
    assert.ok(shown.text.includes("1"), shown.text);
    assert.ok(shown.tooltip.includes("1 of them stranded"), shown.tooltip);
  });

  it("keeps showing a file whose notes are all stranded", async () => {
    const shown = await bar([annotation("one", [comment("c1")], true)]);
    assert.ok(shown.visible);
    assert.ok(shown.text.includes("0 highlights, 1"));
    assert.ok(shown.tooltip.includes("stranded"));
  });

  it("says the notes are hidden while they are", async () => {
    const store = new AnnotationStore();
    await store.initialize();
    assert.ok(await store.add(annotation("one", [])));
    const visibility = new Visibility();
    const document = new TextDocument(Uri.file(nodePath.join(root, "src/a.ts")), "const one = 1;\n");
    workspace.textDocuments = [document];
    (window as { activeTextEditor: unknown }).activeTextEditor = { document };
    const status = new FileStatus(store, visibility);
    closing.push(status, visibility, store);
    const item = statusBars[statusBars.length - 1];
    assert.ok(item.text.includes("$(bookmark)"));
    visibility.toggle();
    assert.ok(item.text.includes("$(eye-closed)"));
    assert.ok(item.tooltip.includes("currently hidden"));
  });
});

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  authentication,
  clipboard,
  faults,
  Position,
  queueInput,
  resetComments,
  resetFake,
  Selection,
  TextDocument,
  Uri,
  warnings,
  window,
  workspace
} from "./fakevscode";
import { Annotation } from "../src/model";
import { CommentCommands } from "../src/comments";
import { HighlightRenderer } from "../src/decorations";
import { HighlightCommands } from "../src/highlights";
import { IdentityProvider } from "../src/identity";
import { LiveRanges } from "../src/live";
import { AnnotationStore } from "../src/store";
import { Visibility } from "../src/visibility";

let root = "";
let opened: Array<{ dispose(): void }> = [];

const SOURCE = "alpha one\nbeta two\ngamma three\n";

function folder(): string {
  const created = fs.mkdtempSync(nodePath.join(os.tmpdir(), "codelight-comments-"));
  fs.mkdirSync(nodePath.join(created, ".vscode"));
  return created;
}

function writeStore(annotations: Annotation[]): void {
  const wire = annotations.map(({ root: _root, ...rest }) => rest);
  fs.writeFileSync(
    nodePath.join(root, ".vscode", "codelight.json"),
    `${JSON.stringify({ version: 1, annotations: wire }, null, 2)}\n`
  );
}

function annotation(id: string, comments: Annotation["comments"]): Annotation {
  return {
    id,
    file: "src/a.ts",
    range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 5 },
    anchor: { text: "alpha", before: "", after: " one\n" },
    color: "yellow",
    author: { login: "ada", id: "42" },
    createdAt: "2026-08-17T09:12:33.000Z",
    updatedAt: "2026-08-17T09:12:33.000Z",
    comments,
    root: Uri.file(root).toString()
  };
}

function comment(id: string, body: string, author = { login: "ada", id: "42" }) {
  return {
    id,
    author,
    body,
    createdAt: "2026-08-17T09:12:33.000Z",
    updatedAt: "2026-08-17T09:12:33.000Z"
  };
}

async function build(): Promise<{ store: AnnotationStore; commands: CommentCommands }> {
  authentication.session = { account: { label: "ada", id: "42" }, accessToken: "t" };
  const store = new AnnotationStore();
  await store.initialize();
  const live = new LiveRanges(store);
  const identity = new IdentityProvider();
  const visibility = new Visibility();
  const renderer = new HighlightRenderer(store, live, visibility);
  const highlights = new HighlightCommands(store, identity, renderer, live, visibility);
  const commands = new CommentCommands(store, identity, highlights);
  const document = new TextDocument(Uri.file(nodePath.join(root, "src/a.ts")), SOURCE);
  workspace.textDocuments = [document];
  window.activeTextEditor = {
    document,
    selection: new Selection(new Position(0, 1), new Position(0, 1)),
    selections: [new Selection(new Position(0, 1), new Position(0, 1))]
  };
  opened.push(renderer, live, visibility, identity, store);
  return { store, commands };
}

beforeEach(() => {
  resetFake();
  resetComments();
  opened = [];
  root = folder();
  fs.mkdirSync(nodePath.join(root, "src"));
  workspace.workspaceFolders = [{ uri: Uri.file(root), name: "root", index: 0 }];
});

afterEach(() => {
  for (const item of opened) {
    item.dispose();
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("CommentCommands.edit", () => {
  it("rescues the typed text when the save fails", async () => {
    const { store, commands } = await build();
    writeStore([annotation("a1", [comment("c1", "first note")])]);
    await store.refresh();
    queueInput("a long rewrite the user just typed");
    faults.writeCode = "EIO";
    await commands.edit("a1");
    faults.writeCode = undefined;
    assert.deepEqual(warnings(), [
      "warning CodeLight could not save the comment. Your comment was copied to the clipboard."
    ]);
    assert.equal(
      clipboard.text,
      "a long rewrite the user just typed",
      "expected the rewrite on the clipboard"
    );
  });
});

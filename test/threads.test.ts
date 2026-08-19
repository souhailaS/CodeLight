import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  authentication,
  clipboard,
  CommentMode,
  messages,
  controllers,
  FakeCommentThread,
  Position,
  Range,
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
import { LiveRanges } from "../src/live";
import { AnnotationStore } from "../src/store";
import { Visibility } from "../src/visibility";
import { IdentityProvider, localId } from "../src/identity";
import { SignInNudge } from "../src/nudge";
import { SharingState } from "../src/sharing";
import { ThreadComment, ThreadView } from "../src/threads";

let root = "";
let opened: Array<{ dispose(): void }> = [];

const SOURCE = "alpha one\nbeta two\ngamma three\ndelta four\nepsilon five\n";

function folder(): string {
  const created = fs.mkdtempSync(nodePath.join(os.tmpdir(), "codelight-threads-"));
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

function annotation(id: string, comments: Annotation["comments"] = []): Annotation {
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

function comment(id: string, body: string) {
  return {
    id,
    author: { login: "ada", id: "42" },
    body,
    createdAt: "2026-08-17T09:12:33.000Z",
    updatedAt: "2026-08-17T09:12:33.000Z"
  };
}

async function build(): Promise<{
  store: AnnotationStore;
  live: LiveRanges;
  identity: IdentityProvider;
  visibility: Visibility;
  view: ThreadView;
  asked: string[];
  document: TextDocument;
  editor: { document: TextDocument; selection: Selection; selections: Selection[] };
}> {
  authentication.session = { account: { label: "ada", id: "42" }, accessToken: "t" };
  const store = new AnnotationStore();
  await store.initialize();
  const live = new LiveRanges(store);
  const identity = new IdentityProvider(async (args) => (args[1] === "user.name" ? "ada" : "ada@b.c"));
  const visibility = new Visibility();
  const document = new TextDocument(Uri.file(nodePath.join(root, "src/a.ts")), SOURCE);
  workspace.textDocuments = [document];
  const asked: string[] = [];
  const sharing = new SharingState(() => Promise.resolve(1));
  const nudge = new SignInNudge(store, sharing);
  (nudge as unknown as { about: (target: Uri, author: { login: string }) => Promise<void> }).about = (
    target,
    author
  ) => {
    asked.push(`${author.login} ${target.path}`);
    return Promise.resolve();
  };
  const view = new ThreadView(store, live, identity, visibility, sharing, nudge);
  const editor = {
    document,
    selection: new Selection(new Position(0, 0), new Position(0, 0)),
    selections: [new Selection(new Position(0, 0), new Position(0, 0))]
  };
  window.activeTextEditor = editor;
  opened.push(view, live, visibility, identity, store);
  return { store, live, identity, visibility, view, document, editor, asked };
}

function threadsOf(): FakeCommentThread[] {
  return controllers.flatMap((controller) => controller.threads).filter((thread) => !thread.disposed);
}

beforeEach(() => {
  resetFake();
  resetComments();
  opened = [];
  root = folder();
  fs.mkdirSync(nodePath.join(root, "src"));
  fs.writeFileSync(nodePath.join(root, "src/a.ts"), SOURCE);
  workspace.workspaceFolders = [{ uri: Uri.file(root), name: "root", index: 0 }];
});

afterEach(() => {
  for (const item of opened) {
    item.dispose();
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("openDraft", () => {
  it("opens a second draft for a selection that does not overlap the first", async () => {
    const { view, editor } = await build();
    editor.selections = [new Selection(new Position(0, 0), new Position(0, 5))];
    await view.openDraft(editor as never);
    assert.equal(threadsOf().length, 1);
    editor.selections = [new Selection(new Position(3, 0), new Position(3, 5))];
    await view.openDraft(editor as never);
    const live = threadsOf();
    assert.equal(live.length, 2, `expected a second draft, saw ${live.length}`);
  });
});

describe("in progress edits", () => {
  it("rescues the edit when the whole annotation disappears", async () => {
    const { store } = await build();
    writeStore([annotation("a1", [comment("c1", "first note")])]);
    await store.refresh();
    const thread = threadsOf()[0];
    assert.ok(thread, "expected a thread for the commented highlight");
    const entry = thread.comments[0] as ThreadComment;
    entry.mode = CommentMode.Editing;
    entry.body = "text I was typing";
    writeStore([]);
    await store.refresh();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(clipboard.text, "text I was typing", "expected the edit on the clipboard");
  });

  it("rescues the edit when the last comment is deleted by another window", async () => {
    const { store } = await build();
    writeStore([annotation("a1", [comment("c1", "first note")])]);
    await store.refresh();
    const thread = threadsOf()[0];
    assert.ok(thread, "expected a thread for the commented highlight");
    const entry = thread.comments[0] as ThreadComment;
    entry.mode = CommentMode.Editing;
    entry.body = "text I was typing";
    writeStore([annotation("a1", [])]);
    await store.refresh();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(clipboard.text, "text I was typing", "expected the edit on the clipboard");
  });

  it("rescues the edit when the highlight becomes orphaned", async () => {
    const { store } = await build();
    writeStore([annotation("a1", [comment("c1", "first note")])]);
    await store.refresh();
    const thread = threadsOf()[0];
    assert.ok(thread, "expected a thread for the commented highlight");
    const entry = thread.comments[0] as ThreadComment;
    entry.mode = CommentMode.Editing;
    entry.body = "text I was typing";
    const orphan = annotation("a1", [comment("c1", "first note")]);
    orphan.orphaned = true;
    writeStore([orphan]);
    await store.refresh();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(clipboard.text, "text I was typing", "expected the edit on the clipboard");
  });

  it("rescues the edit when the notes are hidden", async () => {
    const { store, visibility } = await build();
    writeStore([annotation("a1", [comment("c1", "first note")])]);
    await store.refresh();
    const thread = threadsOf()[0];
    const entry = thread.comments[0] as ThreadComment;
    entry.mode = CommentMode.Editing;
    entry.body = "text I was typing";
    visibility.toggle();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(clipboard.text, "text I was typing", "expected the edit on the clipboard");
  });
});

describe("saveEdit", () => {
  it("puts the typed text on the clipboard when the thread is rebuilt underneath", async () => {
    const { store, visibility, view } = await build();
    writeStore([annotation("a1", [comment("c1", "first note")])]);
    await store.refresh();
    const thread = threadsOf()[0];
    const entry = thread.comments[0] as ThreadComment;
    entry.mode = CommentMode.Editing;
    entry.body = "the edited text";
    visibility.toggle();
    visibility.toggle();
    await view.saveEdit(entry);
    for (let attempt = 0; attempt < 50 && clipboard.text === ""; attempt += 1) {
      await new Promise((done) => setTimeout(done, 5));
    }
    assert.equal(store.byId("a1")?.comments[0].body, "first note");
    assert.equal(clipboard.text, "the edited text");
  });
});

describe("telling the writer their name is not verified", () => {
  it("mentions it once a highlight is written from the gutter", async () => {
    authentication.session = undefined;
    const { view, editor, asked, store } = await build();
    editor.selection = new Selection(new Position(0, 0), new Position(0, 5));
    await view.openDraft(editor as never);
    const draft = threadsOf()[0];
    await view.highlightOnly({ thread: draft, text: "" } as never);
    assert.equal(store.all.length, 1);
    assert.equal(asked.length, 1, asked.join("|"));
  });

  it("mentions it once a comment is written", async () => {
    authentication.session = undefined;
    const { view, editor, asked } = await build();
    editor.selection = new Selection(new Position(0, 0), new Position(0, 5));
    await view.openDraft(editor as never);
    const draft = threadsOf()[0];
    await view.reply({ thread: draft, text: "a first note" } as never);
    assert.equal(asked.length, 1, asked.join("|"));
  });
});

describe("who a comment is shown as", () => {
  it("offers edit and delete on a note you wrote without signing in", async () => {
    authentication.session = undefined;
    const { store, identity, view } = await build();
    await identity.prime();
    const me = { login: "ada", id: localId("ada@b.c") };
    writeStore([annotation("a1", [comment("c1", "first note")])]);
    const stored = JSON.parse(
      fs.readFileSync(nodePath.join(root, ".vscode", "codelight.json"), "utf8")
    ) as { annotations: Array<{ comments: Array<{ author: unknown }> }> };
    stored.annotations[0].comments[0].author = { login: me.login, id: me.id };
    fs.writeFileSync(
      nodePath.join(root, ".vscode", "codelight.json"),
      JSON.stringify(stored, null, 2)
    );
    await store.refresh();
    void view;
    const entry = threadsOf()[0].comments[0] as ThreadComment;
    assert.ok(me.id.startsWith("local:"));
    assert.equal(entry.contextValue, "mine");
  });

  it("does not offer them on someone else's note", async () => {
    authentication.session = undefined;
    const { store, view } = await build();
    writeStore([annotation("a1", [comment("c1", "first note")])]);
    const stored = JSON.parse(
      fs.readFileSync(nodePath.join(root, ".vscode", "codelight.json"), "utf8")
    ) as { annotations: Array<{ comments: Array<{ author: unknown }> }> };
    stored.annotations[0].comments[0].author = { login: "bob", id: "local:someoneelse" };
    fs.writeFileSync(
      nodePath.join(root, ".vscode", "codelight.json"),
      JSON.stringify(stored, null, 2)
    );
    await store.refresh();
    void view;
    const entry = threadsOf()[0].comments[0] as ThreadComment;
    assert.equal(entry.contextValue, "theirs");
  });

  it("shows no avatar for a name git knows rather than a broken one", async () => {
    const { store, view } = await build();
    writeStore([annotation("a1", [comment("c1", "first note")])]);
    const stored = JSON.parse(
      fs.readFileSync(nodePath.join(root, ".vscode", "codelight.json"), "utf8")
    ) as { annotations: Array<{ comments: Array<{ author: { id: string } }> }> };
    stored.annotations[0].comments[0].author.id = "local:abc123";
    fs.writeFileSync(
      nodePath.join(root, ".vscode", "codelight.json"),
      JSON.stringify(stored, null, 2)
    );
    await store.refresh();
    void view;
    const entry = threadsOf()[0].comments[0] as ThreadComment;
    assert.equal((entry.author as { iconPath?: unknown }).iconPath, undefined);
    assert.equal(entry.author.name, "ada");
  });

  it("keeps the github avatar for a numbered account", async () => {
    const { store, view } = await build();
    writeStore([annotation("a1", [comment("c1", "first note")])]);
    await store.refresh();
    void view;
    const entry = threadsOf()[0].comments[0] as ThreadComment;
    assert.ok(String((entry.author as { iconPath?: { toString(): string } }).iconPath).includes("avatars"));
  });
});

describe("a note this version of the file cannot hold", () => {
  it("refuses to open a thread rather than parking it on the wrong line", async () => {
    const { store, view, document } = await build();
    writeStore([annotation("a1", [comment("c1", "first note")])]);
    await store.refresh();
    const rewritten = new TextDocument(document.uri, "let nothing = here;\nlet other = two;\n");
    workspace.textDocuments = [rewritten];
    messages.length = 0;
    await view.open("a1");
    assert.ok(warnings().some((line) => line.includes("cannot find the text")), messages.join("\n"));
    assert.equal(
      threadsOf().some((entry) => entry.contextValue === "draft"),
      false
    );
  });

  it("keeps its comment thread off the gutter of unrelated code", async () => {
    const { store, visibility, document } = await build();
    writeStore([annotation("a1", [comment("c1", "first note")])]);
    await store.refresh();
    assert.ok(threadsOf().filter((entry) => !entry.disposed).length > 0);
    const rewritten = new TextDocument(document.uri, "let nothing = here;\nlet other = two;\n");
    workspace.textDocuments = [rewritten];
    visibility.toggle();
    visibility.toggle();
    assert.deepEqual(
      threadsOf().filter((entry) => !entry.disposed),
      []
    );
  });
});

describe("deleting a comment another window removed", () => {
  it("says so rather than doing nothing", async () => {
    const { store, view } = await build();
    writeStore([annotation("a1", [comment("c1", "first note")])]);
    await store.refresh();
    const thread = threadsOf()[0];
    const entry = thread.comments[0] as ThreadComment;
    writeStore([]);
    await store.refresh();
    messages.length = 0;
    await view.deleteComment(entry);
    assert.ok(warnings().some((line) => line.includes("no longer in the annotation file")));
  });
});

describe("where the gutter offers a comment", () => {
  it("leaves out the trailing empty line it would refuse", async () => {
    const { view, document } = await build();
    const provider = controllers[0].commentingRangeProvider as {
      provideCommentingRanges(document: unknown): Range[];
    };
    void view;
    const ranges = provider.provideCommentingRanges(document);
    assert.equal(ranges.length, 1);
    assert.ok(ranges[0].end.line < document.lineCount - 1);
    assert.ok(document.lineAt(ranges[0].end.line).range.isEmpty === false);
  });

  it("offers nothing at all for an empty file", async () => {
    const { store, view } = await build();
    void store;
    void view;
    const empty = new TextDocument(Uri.file(nodePath.join(root, "src/empty.ts")), "");
    const provider = controllers[0].commentingRangeProvider as {
      provideCommentingRanges(document: unknown): Range[];
    };
    assert.deepEqual(provider.provideCommentingRanges(empty), []);
  });
});

describe("a gutter comment on a trailing empty line", () => {
  it("refuses rather than saving a note with nothing to hold on to", async () => {
    const { store, view, document } = await build();
    const last = document.lineCount - 1;
    const controller = controllers[0];
    const thread = controller.createCommentThread(document.uri, new Range(last, 0, last, 0), []);
    await view.reply({ thread, text: "the first note" } as never);
    assert.deepEqual(store.all, []);
    assert.ok(warnings().some((entry) => entry.includes("That line is empty")));
    assert.equal(clipboard.text, "the first note");
  });

  it("still takes a comment on a line that has text", async () => {
    const { store, view, document } = await build();
    const controller = controllers[0];
    const thread = controller.createCommentThread(document.uri, new Range(0, 0, 0, 0), []);
    await view.reply({ thread, text: "the first note" } as never);
    assert.equal(store.all.length, 1);
    assert.ok(store.all[0].anchor.text.length > 0);
    const saved = threadsOf().find((entry) => entry.contextValue === "saved");
    assert.ok(saved, "expected a saved thread");
    await view.reply({ thread: saved, text: "a second note" } as never);
    assert.equal(store.all[0].comments.length, 2);
  });
});

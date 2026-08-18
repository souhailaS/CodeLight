import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  details,
  messages,
  queueAnswer,
  resetFake,
  ThemeIcon,
  TreeItemCollapsibleState,
  Uri,
  warnings,
  workspace
} from "./fakevscode";
import { LiveRanges } from "../src/live";
import { Annotation, Comment } from "../src/model";
import { AnnotationTree, FileNode, Node, PanelCommands } from "../src/panel";
import { AnnotationStore } from "../src/store";

let root = "";
let closing: Array<{ dispose(): void }> = [];

function comment(id: string, body: string): Comment {
  return {
    id,
    author: { login: "ada", id: "42" },
    body,
    createdAt: "2026-08-17T09:12:33.000Z",
    updatedAt: "2026-08-17T09:12:33.000Z"
  };
}

let line = 0;

function annotation(id: string, file: string, color = "yellow"): Annotation {
  line += 1;
  return {
    id,
    file,
    range: { startLine: line, startCharacter: 0, endLine: line, endCharacter: 5 },
    anchor: { text: "const", before: "", after: "" },
    color,
    author: { login: "ada", id: "42" },
    createdAt: "2026-08-17T09:12:33.000Z",
    updatedAt: "2026-08-17T09:12:33.000Z",
    comments: [],
    root: Uri.file(root).toString()
  };
}

async function panel(): Promise<{
  store: AnnotationStore;
  tree: AnnotationTree;
  commands: PanelCommands;
}> {
  const store = new AnnotationStore();
  await store.initialize();
  const live = new LiveRanges(store);
  const tree = new AnnotationTree(store);
  const commands = new PanelCommands(store, live, tree);
  closing.push(tree, live, store);
  return { store, tree, commands };
}

function files(tree: AnnotationTree): FileNode[] {
  return tree.getChildren().filter((node): node is FileNode => node.kind === "file");
}

beforeEach(() => {
  resetFake();
  closing = [];
  line = 0;
  root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "codelight-panel-"));
  fs.mkdirSync(nodePath.join(root, ".vscode"));
  workspace.workspaceFolders = [{ uri: Uri.file(root), name: "root", index: 0 }];
});

afterEach(() => {
  for (const item of closing) {
    item.dispose();
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the annotation tree", () => {
  it("groups the annotations by the file they mark", async () => {
    const { store, tree } = await panel();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    assert.ok(await store.add(annotation("two", "src/b.ts")));
    assert.ok(await store.add(annotation("three", "src/a.ts")));
    assert.deepEqual(
      files(tree).map((node) => node.file),
      ["src/a.ts", "src/b.ts"]
    );
    assert.deepEqual(
      files(tree)[0].annotations.map((entry) => entry.id),
      ["one", "three"]
    );
    assert.deepEqual(
      files(tree)[0].annotations.map((entry) => entry.range.startLine),
      [1, 3]
    );
  });

  it("orders the rows of a file by the line they sit on", async () => {
    const { store, tree } = await panel();
    const lower = annotation("lower", "src/a.ts");
    lower.range = { startLine: 40, startCharacter: 0, endLine: 40, endCharacter: 5 };
    const upper = annotation("upper", "src/a.ts");
    upper.range = { startLine: 4, startCharacter: 0, endLine: 4, endCharacter: 5 };
    assert.ok(await store.add(lower));
    assert.ok(await store.add(upper));
    assert.deepEqual(
      files(tree)[0].annotations.map((entry) => entry.id),
      ["upper", "lower"]
    );
  });

  it("puts the comments of an annotation under it", async () => {
    const { store, tree } = await panel();
    const entry = annotation("one", "src/a.ts");
    entry.comments = [comment("c1", "first"), comment("c2", "second")];
    assert.ok(await store.add(entry));
    const file = files(tree)[0];
    const rows = tree.getChildren(file);
    assert.deepEqual(
      rows.map((node) => node.kind),
      ["annotation"]
    );
    const comments = tree.getChildren(rows[0]);
    assert.deepEqual(
      comments.map((node) => (node.kind === "comment" ? node.comment.body : "")),
      ["first", "second"]
    );
    assert.deepEqual(tree.getChildren(comments[0]), []);
  });

  it("shows a file row that opens the file and an annotation row that reveals it", async () => {
    const { store, tree } = await panel();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    const file = files(tree)[0];
    const fileItem = tree.getTreeItem(file);
    assert.equal(fileItem.label, "a.ts");
    assert.equal(fileItem.description, "src");
    assert.equal(fileItem.resourceUri?.fsPath, nodePath.join(root, "src/a.ts"));
    assert.equal(fileItem.collapsibleState, TreeItemCollapsibleState.Expanded);
    const row = tree.getTreeItem(tree.getChildren(file)[0]);
    assert.equal(row.description, "@ada");
    assert.equal(row.command?.command, "codelight.revealAnnotation");
    assert.deepEqual(row.command?.arguments, ["one"]);
    assert.equal(row.collapsibleState, TreeItemCollapsibleState.None);
  });

  it("says how many comments a row carries and marks an orphan", async () => {
    const { store, tree } = await panel();
    const entry = annotation("one", "src/a.ts");
    entry.comments = [comment("c1", "first")];
    entry.orphaned = true;
    assert.ok(await store.add(entry));
    const row = tree.getTreeItem(tree.getChildren(files(tree)[0])[0]);
    assert.equal(row.description, "@ada, 1 comment, text deleted");
    assert.equal(row.contextValue, "codelight.orphan");
    assert.equal(row.collapsibleState, TreeItemCollapsibleState.Collapsed);
    assert.equal((row.iconPath as ThemeIcon).id, "circle-slash");
  });

  it("keeps only one colour while a filter is on", async () => {
    const { store, tree } = await panel();
    assert.ok(await store.add(annotation("one", "src/a.ts", "yellow")));
    assert.ok(await store.add(annotation("two", "src/b.ts", "pink")));
    tree.setFilter("pink");
    assert.deepEqual(
      files(tree).map((node) => node.file),
      ["src/b.ts"]
    );
    tree.setFilter(undefined);
    assert.equal(files(tree).length, 2);
  });

  it("tells the tree to redraw when the store changes", async () => {
    const { store, tree } = await panel();
    let drawn = 0;
    const listener = tree.onDidChangeTreeData(() => {
      drawn += 1;
    });
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    listener.dispose();
    assert.ok(drawn > 0);
  });
});

describe("deleting from the panel", () => {
  it("removes one highlight without asking when it carries no comment", async () => {
    const { store, commands } = await panel();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    assert.ok(await store.add(annotation("two", "src/a.ts")));
    await commands.deleteAnnotation("one");
    assert.deepEqual(
      store.all.map((entry) => entry.id),
      ["two"]
    );
  });

  it("asks first when the highlight carries comments", async () => {
    const { store, commands } = await panel();
    const entry = annotation("one", "src/a.ts");
    entry.comments = [comment("c1", "first")];
    assert.ok(await store.add(entry));
    await commands.deleteAnnotation("one");
    assert.deepEqual(
      store.all.map((item) => item.id),
      ["one"]
    );
    queueAnswer("Remove");
    await commands.deleteAnnotation("one");
    assert.deepEqual(store.all, []);
  });

  it("takes the row the tree view hands it", async () => {
    const { store, tree, commands } = await panel();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    const row = tree.getChildren(files(tree)[0])[0];
    await commands.deleteAnnotation(row);
    assert.deepEqual(store.all, []);
  });

  it("keeps the file when the question is not answered", async () => {
    const { store, tree, commands } = await panel();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    await commands.deleteFile(files(tree)[0]);
    assert.equal(store.all.length, 1);
  });

  it("keeps the orphans when the question is not answered", async () => {
    const { store, commands } = await panel();
    const gone = annotation("one", "src/a.ts");
    gone.orphaned = true;
    assert.ok(await store.add(gone));
    await commands.deleteOrphansEverywhere();
    assert.equal(store.all.length, 1);
  });

  it("removes every highlight of one file and leaves the others", async () => {
    const { store, tree, commands } = await panel();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    assert.ok(await store.add(annotation("two", "src/a.ts")));
    assert.ok(await store.add(annotation("three", "src/b.ts")));
    queueAnswer("Remove");
    await commands.deleteFile(files(tree)[0]);
    assert.deepEqual(
      store.all.map((entry) => entry.id),
      ["three"]
    );
  });

  it("refuses when the comments changed under it", async () => {
    const { store, tree, commands } = await panel();
    const entry = annotation("one", "src/a.ts");
    entry.comments = [comment("c1", "first")];
    assert.ok(await store.add(entry));
    const stale = files(tree)[0];
    assert.ok(
      await store.update("one", (current) => ({
        ...current,
        comments: [...current.comments, comment("c2", "second")]
      }))
    );
    queueAnswer("Remove");
    messages.length = 0;
    await commands.deleteFile(stale);
    assert.equal(store.all.length, 1);
    assert.ok(warnings().some((message) => message.includes("just changed")));
  });

  it("notices a change another window made before it deletes", async () => {
    const { store, tree, commands } = await panel();
    const entry = annotation("one", "src/a.ts");
    entry.comments = [comment("c1", "first")];
    assert.ok(await store.add(entry));
    const node = files(tree)[0];
    const path = nodePath.join(root, ".vscode", "codelight.json");
    const disk = JSON.parse(fs.readFileSync(path, "utf8")) as {
      annotations: Array<{ comments: unknown[] }>;
    };
    disk.annotations[0].comments.push(comment("c2", "second"));
    fs.writeFileSync(path, JSON.stringify(disk));
    queueAnswer("Remove");
    messages.length = 0;
    await commands.deleteFile(node);
    assert.equal(store.all.length, 1);
    assert.ok(warnings().some((message) => message.includes("just changed")));
  });

  it("clears out every orphan in the project", async () => {
    const { store, commands } = await panel();
    const gone = annotation("one", "src/a.ts");
    gone.orphaned = true;
    const other = annotation("two", "src/b.ts");
    other.orphaned = true;
    assert.ok(await store.add(gone));
    assert.ok(await store.add(other));
    assert.ok(await store.add(annotation("three", "src/c.ts")));
    queueAnswer("Delete");
    await commands.deleteOrphansEverywhere();
    assert.deepEqual(
      store.all.map((entry) => entry.id),
      ["three"]
    );
  });

  it("keeps the caveat out of a modal that has no filter on", async () => {
    const { store, commands } = await panel();
    const gone = annotation("one", "src/a.ts");
    gone.orphaned = true;
    assert.ok(await store.add(gone));
    details.length = 0;
    queueAnswer("Delete");
    await commands.deleteOrphansEverywhere();
    assert.ok(details.some((line) => line.includes("every folder of the workspace")));
    assert.equal(
      details.some((line) => line.includes("colour filter")),
      false
    );
  });

  it("says the colour filter does not narrow the clearing", async () => {
    const { store, tree, commands } = await panel();
    const gone = annotation("one", "src/a.ts", "yellow");
    gone.orphaned = true;
    const other = annotation("two", "src/b.ts", "pink");
    other.orphaned = true;
    assert.ok(await store.add(gone));
    assert.ok(await store.add(other));
    tree.setFilter("yellow");
    details.length = 0;
    queueAnswer("Delete");
    await commands.deleteOrphansEverywhere();
    assert.ok(details.some((line) => line.includes("colour filter does not narrow it")));
    assert.ok(details.some((line) => line.includes("every folder of the workspace")));
    assert.deepEqual(store.all, []);
  });

  it("says so when a row points at a highlight that is gone", async () => {
    const { store, commands } = await panel();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    messages.length = 0;
    await commands.reveal("not-a-real-id");
    assert.ok(warnings().some((line) => line.includes("no longer in the annotation file")));
  });

  it("says so when there is no orphan to clear", async () => {
    const { store, commands } = await panel();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    messages.length = 0;
    await commands.deleteOrphansEverywhere();
    assert.equal(store.all.length, 1);
    assert.ok(messages.some((message) => message.includes("No orphaned highlights")));
  });

  it("ignores a node that is not a file", async () => {
    const { store, commands } = await panel();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    const row: Node = { kind: "annotation", annotation: store.byId("one")! };
    await commands.deleteFile(row);
    assert.equal(store.all.length, 1);
  });
});

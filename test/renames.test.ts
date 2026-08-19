import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { filesRenamed, resetFake, Uri, workspace } from "./fakevscode";
import { Annotation } from "../src/model";
import { RenameWatcher } from "../src/renames";
import { AnnotationStore } from "../src/store";

let root = "";
let closing: Array<{ dispose(): void }> = [];

function annotation(id: string, file: string, where = root): Annotation {
  return {
    id,
    file,
    range: { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 5 },
    anchor: { text: "const", before: "", after: "" },
    color: "yellow",
    author: { login: "ada", id: "42" },
    createdAt: "t",
    updatedAt: "t",
    comments: [],
    root: Uri.file(where).toString()
  };
}

async function rig(): Promise<{ store: AnnotationStore; watcher: RenameWatcher }> {
  const store = new AnnotationStore();
  await store.initialize();
  const watcher = new RenameWatcher(store);
  closing.push(watcher, store);
  return { store, watcher };
}

function at(...parts: string[]): Uri {
  return Uri.file(nodePath.join(root, ...parts));
}

function files(store: AnnotationStore): string[] {
  return store.all.map((entry) => entry.file).sort();
}

beforeEach(() => {
  resetFake();
  closing = [];
  root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "codelight-rename-"));
  fs.mkdirSync(nodePath.join(root, ".vscode"));
  workspace.workspaceFolders = [{ uri: Uri.file(root), name: "root", index: 0 }];
});

afterEach(() => {
  for (const item of closing) {
    item.dispose();
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("notes after a rename", () => {
  it("follows a file that was given a new name", async () => {
    const { store, watcher } = await rig();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    assert.ok(await store.add(annotation("two", "src/b.ts")));
    assert.equal(await watcher.follow([{ oldUri: at("src/a.ts"), newUri: at("src/c.ts") }]), 1);
    assert.deepEqual(files(store), ["src/b.ts", "src/c.ts"]);
  });

  it("follows every file under a folder that moved", async () => {
    const { store, watcher } = await rig();
    assert.ok(await store.add(annotation("one", "src/deep/a.ts")));
    assert.ok(await store.add(annotation("two", "src/deep/nested/b.ts")));
    assert.ok(await store.add(annotation("three", "other/c.ts")));
    assert.equal(await watcher.follow([{ oldUri: at("src"), newUri: at("lib") }]), 2);
    assert.deepEqual(files(store), ["lib/deep/a.ts", "lib/deep/nested/b.ts", "other/c.ts"]);
  });

  it("takes one write for a whole batch", async () => {
    const { store, watcher } = await rig();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    assert.ok(await store.add(annotation("two", "src/b.ts")));
    let wrote = 0;
    const listener = store.onDidChange(() => {
      wrote += 1;
    });
    await watcher.follow([
      { oldUri: at("src/a.ts"), newUri: at("src/x.ts") },
      { oldUri: at("src/b.ts"), newUri: at("src/y.ts") }
    ]);
    listener.dispose();
    assert.equal(wrote, 1);
    assert.deepEqual(files(store), ["src/x.ts", "src/y.ts"]);
  });

  it("leaves a note alone when the file left the workspace", async () => {
    const { store, watcher } = await rig();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    assert.equal(await watcher.follow([{ oldUri: at("src/a.ts"), newUri: Uri.file("/elsewhere/a.ts") }]), 0);
    assert.deepEqual(files(store), ["src/a.ts"]);
  });

  it("ignores a file no folder holds", async () => {
    const { store, watcher } = await rig();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    assert.equal(
      await watcher.follow([{ oldUri: Uri.file("/elsewhere/a.ts"), newUri: at("src/a.ts") }]),
      0
    );
    assert.deepEqual(files(store), ["src/a.ts"]);
  });

  it("does not touch a name that merely starts the same", async () => {
    const { store, watcher } = await rig();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    assert.ok(await store.add(annotation("two", "src/ab.ts")));
    await watcher.follow([{ oldUri: at("src/a.ts"), newUri: at("src/z.ts") }]);
    assert.deepEqual(files(store), ["src/ab.ts", "src/z.ts"]);
  });

  it("does not take a folder with a longer name along", async () => {
    const { store, watcher } = await rig();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    assert.ok(await store.add(annotation("two", "srcx/a.ts")));
    assert.equal(await watcher.follow([{ oldUri: at("src"), newUri: at("lib") }]), 1);
    assert.deepEqual(files(store), ["lib/a.ts", "srcx/a.ts"]);
  });

  it("follows a rename the editor reports", async () => {
    const { store } = await rig();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    filesRenamed.fire({ files: [{ oldUri: at("src/a.ts"), newUri: at("src/c.ts") }] });
    for (let attempt = 0; attempt < 60 && files(store)[0] !== "src/c.ts"; attempt += 1) {
      await new Promise((done) => setTimeout(done, 10));
    }
    assert.deepEqual(files(store), ["src/c.ts"]);
  });

  it("keeps the notes of each folder in its own file", async () => {
    const second = fs.mkdtempSync(nodePath.join(os.tmpdir(), "codelight-second-"));
    fs.mkdirSync(nodePath.join(second, ".vscode"));
    workspace.workspaceFolders = [
      { uri: Uri.file(root), name: "root", index: 0 },
      { uri: Uri.file(second), name: "second", index: 1 }
    ];
    const { store, watcher } = await rig();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    assert.ok(await store.add(annotation("two", "src/a.ts", second)));
    assert.equal(await watcher.follow([{ oldUri: at("src/a.ts"), newUri: at("src/c.ts") }]), 1);
    assert.equal(store.byId("one")?.file, "src/c.ts");
    assert.equal(store.byId("two")?.file, "src/a.ts");
    fs.rmSync(second, { recursive: true, force: true });
  });
});

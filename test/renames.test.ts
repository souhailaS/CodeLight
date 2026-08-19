import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { faults, filesRenamed, resetFake, Uri, warnings, workspace } from "./fakevscode";
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

function second(): string {
  const other = fs.mkdtempSync(nodePath.join(os.tmpdir(), "codelight-other-"));
  fs.mkdirSync(nodePath.join(other, ".vscode"));
  workspace.workspaceFolders = [
    { uri: Uri.file(root), name: "root", index: 0 },
    { uri: Uri.file(other), name: "other", index: 1 }
  ];
  closing.push({ dispose: () => fs.rmSync(other, { recursive: true, force: true }) });
  return other;
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

  it("leaves a note where it was when the file left the workspace", async () => {
    const { store, watcher } = await rig();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    assert.equal(
      await watcher.follow([{ oldUri: at("src/a.ts"), newUri: Uri.file("/elsewhere/a.ts") }]),
      0
    );
    assert.deepEqual(files(store), ["src/a.ts"]);
    assert.equal(store.byId("one")?.orphaned, undefined);
  });

  it("follows a file the inner folder and the outer folder both cover", async () => {
    const inner = nodePath.join(root, "packages", "inner");
    fs.mkdirSync(nodePath.join(inner, ".vscode"), { recursive: true });
    workspace.workspaceFolders = [
      { uri: Uri.file(root), name: "root", index: 0 },
      { uri: Uri.file(inner), name: "inner", index: 1 }
    ];
    const { store, watcher } = await rig();
    assert.ok(await store.add(annotation("outer", "packages/inner/src/a.ts")));
    assert.ok(await store.add(annotation("inner", "src/a.ts", inner)));
    assert.equal(
      await watcher.follow([
        { oldUri: at("packages/inner/src/a.ts"), newUri: at("packages/inner/src/b.ts") }
      ]),
      2
    );
    assert.equal(store.byId("outer")?.file, "packages/inner/src/b.ts");
    assert.equal(store.byId("inner")?.file, "src/b.ts");
  });

  it("counts only the notes it really moved", async () => {
    const second = fs.mkdtempSync(nodePath.join(os.tmpdir(), "codelight-quiet-"));
    fs.mkdirSync(nodePath.join(second, ".vscode"));
    workspace.workspaceFolders = [
      { uri: Uri.file(root), name: "root", index: 0 },
      { uri: Uri.file(second), name: "second", index: 1 }
    ];
    const { store, watcher } = await rig();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    assert.equal(
      await watcher.follow([
        { oldUri: at("src/a.ts"), newUri: at("src/c.ts") },
        { oldUri: Uri.file(nodePath.join(second, "src/x.ts")), newUri: Uri.file(nodePath.join(second, "src/y.ts")) }
      ]),
      1
    );
    assert.deepEqual(files(store), ["src/c.ts"]);
    fs.rmSync(second, { recursive: true, force: true });
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

describe("renames that are not a plain move inside one folder", () => {
  it("hands a note to the folder the file moved into", async () => {
    const other = second();
    const { store, watcher } = await rig();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    assert.equal(
      await watcher.follow([
        { oldUri: at("src/a.ts"), newUri: Uri.file(nodePath.join(other, "src/a.ts")) }
      ]),
      1
    );
    const moved = store.byId("one");
    assert.equal(moved?.file, "src/a.ts");
    assert.equal(moved?.root, Uri.file(other).toString());
    assert.deepEqual(
      store.folders.map((folder) => [folder.key, folder.all.length]),
      [
        [Uri.file(root).toString(), 0],
        [Uri.file(other).toString(), 1]
      ]
    );
  });

  it("keeps a note that left the workspace and says it stayed behind", async () => {
    const { store, watcher } = await rig();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    assert.equal(
      await watcher.follow([{ oldUri: at("src/a.ts"), newUri: Uri.file("/elsewhere/a.ts") }]),
      0
    );
    assert.equal(store.byId("one")?.file, "src/a.ts");
    assert.ok(warnings().some((line) => line.includes("out of this workspace")), warnings().join("|"));
  });

  it("resolves a folder rename and a rename inside it in one batch", async () => {
    const { store, watcher } = await rig();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    assert.ok(await store.add(annotation("two", "src/a.ts")));
    await watcher.follow([
      { oldUri: at("src"), newUri: at("lib") },
      { oldUri: at("src/a.ts"), newUri: at("src/b.ts") }
    ]);
    assert.equal(store.byId("one")?.file, "lib/b.ts");
  });

  it("resolves the same batch whichever order it arrives in", async () => {
    const { store, watcher } = await rig();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    await watcher.follow([
      { oldUri: at("src/a.ts"), newUri: at("src/b.ts") },
      { oldUri: at("src"), newUri: at("lib") }
    ]);
    assert.equal(store.byId("one")?.file, "lib/b.ts");
  });

  it("applies two events in the order they arrived", async () => {
    const { store, watcher } = await rig();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    const first = watcher.follow([{ oldUri: at("src"), newUri: at("lib") }]);
    const next = watcher.follow([{ oldUri: at("lib"), newUri: at("out") }]);
    await Promise.all([first, next]);
    assert.equal(store.byId("one")?.file, "out/a.ts");
  });

  it("strands the notes on a file a rename wrote over", async () => {
    const { store, watcher } = await rig();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    assert.ok(await store.add(annotation("two", "src/b.ts")));
    assert.equal(await watcher.follow([{ oldUri: at("src/a.ts"), newUri: at("src/b.ts") }]), 1);
    assert.equal(store.byId("one")?.file, "src/b.ts");
    assert.equal(store.byId("one")?.orphaned, undefined);
    assert.equal(store.byId("two")?.orphaned, true);
  });

  it("says the notes stayed put when the annotation file cannot be written", async () => {
    const { store, watcher } = await rig();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    fs.writeFileSync(
      nodePath.join(root, ".vscode", "codelight.json"),
      ["<<<<<<< HEAD", "{}", "=======", "{}", ">>>>>>> branch"].join("\n")
    );
    assert.equal(await watcher.follow([{ oldUri: at("src/a.ts"), newUri: at("src/c.ts") }]), 0);
    assert.equal(store.byId("one")?.file, "src/a.ts");
    assert.ok(
      warnings().some((line) => line.includes("has a merge conflict in it")),
      warnings().join("|")
    );
  });

  it("waits for the store to be read before it follows anything", async () => {
    const { root: _root, ...wire } = annotation("one", "src/a.ts");
    fs.writeFileSync(
      nodePath.join(root, ".vscode", "codelight.json"),
      `${JSON.stringify({ version: 1, annotations: [wire] }, null, 2)}\n`
    );
    const store = new AnnotationStore();
    const ready = store.initialize();
    const watcher = new RenameWatcher(store, ready);
    closing.push(watcher, store);
    const following = watcher.follow([{ oldUri: at("src/a.ts"), newUri: at("src/c.ts") }]);
    await ready;
    assert.equal(await following, 1);
    assert.equal(store.byId("one")?.file, "src/c.ts");
  });

  it(
    "follows a folder whose notes spell the path in another case",
    { skip: process.platform !== "darwin" && process.platform !== "win32" },
    async () => {
      const { store, watcher } = await rig();
      assert.ok(await store.add(annotation("one", "SRC/a.ts")));
      assert.equal(await watcher.follow([{ oldUri: at("src"), newUri: at("lib") }]), 1);
      assert.equal(store.byId("one")?.file, "lib/a.ts");
    }
  );

  it("writes nothing when the name did not really change", async () => {
    const { store, watcher } = await rig();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    const before = fs.readFileSync(nodePath.join(root, ".vscode", "codelight.json"), "utf8");
    assert.equal(await watcher.follow([{ oldUri: at("src/a.ts"), newUri: at("src/a.ts") }]), 0);
    assert.equal(fs.readFileSync(nodePath.join(root, ".vscode", "codelight.json"), "utf8"), before);
  });
});

function onDisk(where: string, annotations: Annotation[]): void {
  const wire = annotations.map(({ root: _root, ...rest }) => rest);
  fs.writeFileSync(
    nodePath.join(where, ".vscode", "codelight.json"),
    `${JSON.stringify({ version: 1, annotations: wire }, null, 2)}\n`
  );
}

function read(where: string): Annotation[] {
  const file = nodePath.join(where, ".vscode", "codelight.json");
  if (!fs.existsSync(file)) {
    return [];
  }
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { annotations: Annotation[] }).annotations;
}

describe("renames read the annotation file rather than trusting what is loaded", () => {
  it("strands the notes the arriving file writes over in the other folder", async () => {
    const other = second();
    const { store, watcher } = await rig();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    assert.ok(await store.add(annotation("two", "src/a.ts", other)));
    assert.equal(
      await watcher.follow([
        { oldUri: at("src/a.ts"), newUri: Uri.file(nodePath.join(other, "src/a.ts")) }
      ]),
      1
    );
    const landed = read(other);
    assert.equal(landed.length, 2);
    assert.equal(landed.find((entry) => entry.id === "one")?.orphaned, undefined);
    assert.equal(landed.find((entry) => entry.id === "two")?.orphaned, true);
  });

  it("carries the note the file holds, not the one in memory", async () => {
    const other = second();
    const { store, watcher } = await rig();
    const entry = annotation("one", "src/a.ts");
    assert.ok(await store.add(entry));
    onDisk(root, [
      {
        ...entry,
        comments: [
          {
            id: "c1",
            author: { login: "ada", id: "42" },
            body: "written by a colleague",
            createdAt: "t",
            updatedAt: "t"
          }
        ]
      }
    ]);
    await watcher.follow([
      { oldUri: at("src/a.ts"), newUri: Uri.file(nodePath.join(other, "src/a.ts")) }
    ]);
    assert.equal(read(other)[0].comments[0]?.body, "written by a colleague");
    assert.deepEqual(read(root), []);
  });

  it("leaves a note alone when the file it is on is not the one that moved", async () => {
    const { store, watcher } = await rig();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    onDisk(root, [annotation("victim", "src/c.ts")]);
    assert.equal(await watcher.follow([{ oldUri: at("src/a.ts"), newUri: at("src/c.ts") }]), 0);
    assert.equal(read(root).find((entry) => entry.id === "victim")?.orphaned, undefined);
    assert.deepEqual(warnings(), []);
  });

  it("applies each entry of a batch to the path a note started on", async () => {
    const { store, watcher } = await rig();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    assert.ok(await store.add(annotation("two", "src/b.ts")));
    await watcher.follow([
      { oldUri: at("src/a.ts"), newUri: at("src/b.ts") },
      { oldUri: at("src/b.ts"), newUri: at("src/c.ts") }
    ]);
    assert.equal(store.byId("one")?.file, "src/b.ts");
    assert.equal(store.byId("two")?.file, "src/c.ts");
  });

  it(
    "strands a note the rename wrote over even when the two paths differ only in case",
    { skip: process.platform !== "darwin" && process.platform !== "win32" },
    async () => {
      const { store, watcher } = await rig();
      assert.ok(await store.add(annotation("one", "src/a.ts")));
      assert.ok(await store.add(annotation("two", "src/B.ts")));
      assert.equal(await watcher.follow([{ oldUri: at("src/a.ts"), newUri: at("src/b.ts") }]), 1);
      assert.equal(store.byId("two")?.orphaned, true);
    }
  );

  it("says it could not write when the write is the thing that failed", async () => {
    const { store, watcher } = await rig();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    faults.writeCode = "EIO";
    assert.equal(await watcher.follow([{ oldUri: at("src/a.ts"), newUri: at("src/c.ts") }]), 0);
    faults.writeCode = undefined;
    assert.ok(
      warnings().some((line) => line.includes("could not write the annotation file")),
      warnings().join("|")
    );
    assert.equal(store.byId("one")?.file, "src/a.ts");
  });

  it("does not hand a note to another folder while the one it is in is conflicted", async () => {
    const other = second();
    const { store, watcher } = await rig();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    fs.writeFileSync(
      nodePath.join(root, ".vscode", "codelight.json"),
      ["<<<<<<< HEAD", "{}", "=======", "{}", ">>>>>>> branch"].join("\n")
    );
    await store.refresh();
    assert.equal(
      await watcher.follow([
        { oldUri: at("src/a.ts"), newUri: Uri.file(nodePath.join(other, "src/a.ts")) }
      ]),
      0
    );
    assert.deepEqual(read(other), []);
  });
});

describe("renames across folders that overlap", () => {
  it("leaves a note that moved with the file alone when another one lands on it", async () => {
    const inner = nodePath.join(root, "packages", "inner");
    fs.mkdirSync(nodePath.join(inner, ".vscode"), { recursive: true });
    workspace.workspaceFolders = [
      { uri: Uri.file(root), name: "root", index: 0 },
      { uri: Uri.file(inner), name: "inner", index: 1 }
    ];
    const { store, watcher } = await rig();
    assert.ok(await store.add(annotation("outer", "packages/inner/src/a.ts")));
    assert.ok(await store.add(annotation("inner", "src/a.ts", inner)));
    await watcher.follow([
      { oldUri: at("packages/inner/src/a.ts"), newUri: at("top/a.ts") }
    ]);
    assert.equal(store.byId("outer")?.file, "top/a.ts");
    assert.equal(store.byId("outer")?.orphaned, undefined);
    assert.equal(store.byId("inner")?.orphaned, undefined);
  });

  it("stays quiet about a conflict when the rename touches no note", async () => {
    const { store, watcher } = await rig();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    fs.writeFileSync(
      nodePath.join(root, ".vscode", "codelight.json"),
      ["<<<<<<< HEAD", "{}", "=======", "{}", ">>>>>>> branch"].join("\n")
    );
    await store.refresh();
    assert.equal(await watcher.follow([{ oldUri: at("other/x.ts"), newUri: at("other/y.ts") }]), 0);
    assert.equal(
      warnings().some((line) => line.includes("still point at the old path")),
      false,
      warnings().join("|")
    );
  });

  it("blames the conflict when the folder the file arrives in has one", async () => {
    const other = second();
    fs.writeFileSync(
      nodePath.join(other, ".vscode", "codelight.json"),
      ["<<<<<<< HEAD", "{}", "=======", "{}", ">>>>>>> branch"].join("\n")
    );
    const { store, watcher } = await rig();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    await watcher.follow([
      { oldUri: at("src/a.ts"), newUri: Uri.file(nodePath.join(other, "src/a.ts")) }
    ]);
    assert.ok(
      warnings().some((line) => line.includes("merge conflict")),
      warnings().join("|")
    );
    assert.equal(
      warnings().some((line) => line.includes("could not write the annotation file")),
      false
    );
    assert.equal(store.byId("one")?.file, "src/a.ts");
  });

  it("keeps a note inside the folder an earlier entry moved it into", async () => {
    const { store, watcher } = await rig();
    assert.ok(await store.add(annotation("one", "src/a/x.ts")));
    await watcher.follow([
      { oldUri: at("src/a"), newUri: at("top/a") },
      { oldUri: at("src"), newUri: at("lib") }
    ]);
    assert.equal(store.byId("one")?.file, "top/a/x.ts");
  });

  it("strands the notes on a file written over even when the mover was already there", async () => {
    const { store, watcher } = await rig();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    assert.ok(await store.add(annotation("two", "src/b.ts")));
    onDisk(root, [annotation("one", "src/b.ts"), annotation("two", "src/b.ts")]);
    await watcher.follow([{ oldUri: at("src/a.ts"), newUri: at("src/b.ts") }]);
    const held = read(root);
    assert.equal(held.find((entry) => entry.id === "two")?.orphaned, true);
    assert.equal(held.find((entry) => entry.id === "one")?.orphaned, undefined);
  });

  it("says so when the write that only stranded a note failed", async () => {
    const { store, watcher } = await rig();
    assert.ok(await store.add(annotation("one", "src/a.ts")));
    assert.ok(await store.add(annotation("two", "src/b.ts")));
    onDisk(root, [annotation("one", "src/b.ts"), annotation("two", "src/b.ts")]);
    faults.writeCode = "EIO";
    await watcher.follow([{ oldUri: at("src/a.ts"), newUri: at("src/b.ts") }]);
    faults.writeCode = undefined;
    assert.ok(
      warnings().some((line) => line.includes("could not write the annotation file")),
      warnings().join("|")
    );
  });

  it("does not count a note that had already lost its text as left behind", async () => {
    const { store, watcher } = await rig();
    const gone = annotation("one", "src/a.ts");
    gone.orphaned = true;
    assert.ok(await store.add(gone));
    assert.equal(
      await watcher.follow([{ oldUri: at("src/a.ts"), newUri: Uri.file("/elsewhere/a.ts") }]),
      0
    );
    assert.deepEqual(warnings(), []);
  });
});

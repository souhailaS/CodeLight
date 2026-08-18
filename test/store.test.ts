import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  clearFaults,
  errors,
  faults,
  messages,
  queueAnswer,
  resetFake,
  setConfiguration,
  Uri,
  warnings,
  workspace
} from "./fakevscode";
import { Annotation } from "../src/model";
import { AnnotationStore } from "../src/store";

const LIMIT = 64 * 1024 * 1024;
const UNPRIVILEGED = typeof process.getuid === "function" && process.getuid() !== 0;
const READ_ONLY_FOLDER = {
  skip: UNPRIVILEGED ? false : "a read only folder needs a user its permissions apply to"
};

let root = "";
let vscodeDir = "";
let jsonPath = "";
let gzPath = "";
let opened: AnnotationStore[] = [];

function annotation(id: string): Annotation {
  return {
    id,
    file: "src/a.ts",
    range: { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 5 },
    anchor: { text: "const", before: "", after: "" },
    color: "yellow",
    author: { login: "ada", id: "42" },
    createdAt: "2026-08-17T09:12:33.000Z",
    updatedAt: "2026-08-17T09:12:33.000Z",
    comments: []
  };
}

function bulky(id: string): Annotation {
  const entry = annotation(id);
  entry.comments = [
    {
      id: "c",
      author: { login: "ada", id: "42" },
      body: "x".repeat(LIMIT + 1024),
      createdAt: "t",
      updatedAt: "t"
    }
  ];
  return entry;
}

function ids(store: AnnotationStore): string[] {
  return store.all.map((entry) => entry.id).sort();
}

function plainText(): string {
  return fs.readFileSync(jsonPath, "utf8");
}

function compressedText(): string {
  return gunzipSync(fs.readFileSync(gzPath)).toString("utf8");
}

function entries(): string[] {
  return fs.readdirSync(vscodeDir).sort();
}

function age(target: string, seconds: number): void {
  const when = new Date(Date.now() + seconds * 1000);
  fs.utimesSync(target, when, when);
}

async function open(mode: "json" | "compressed"): Promise<AnnotationStore> {
  setConfiguration("codelight.storage", mode);
  const store = new AnnotationStore();
  opened.push(store);
  await store.initialize();
  return store;
}

async function settle(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt += 1) {
    await new Promise((done) => setTimeout(done, 10));
  }
}

beforeEach(() => {
  resetFake();
  opened = [];
  root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "codelight-test-"));
  vscodeDir = nodePath.join(root, ".vscode");
  jsonPath = nodePath.join(vscodeDir, "codelight.json");
  gzPath = nodePath.join(vscodeDir, "codelight.json.gz");
  fs.mkdirSync(vscodeDir);
  workspace.workspaceFolders = [{ uri: Uri.file(root), name: "root", index: 0 }];
});

afterEach(() => {
  for (const store of opened) {
    store.dispose();
  }
  fs.chmodSync(vscodeDir, 0o700);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("creating a store", () => {
  it("binds to the workspace folder", async () => {
    const store = await open("json");
    assert.ok(store.isReady);
    assert.equal(store.rootUri?.fsPath, root);
    assert.deepEqual(store.all, []);
    assert.equal(store.location, undefined);
  });

  it("has no root without a workspace folder", async () => {
    workspace.workspaceFolders = [];
    const store = await open("json");
    assert.equal(store.isReady, false);
    assert.equal(await store.add(annotation("one")), false);
  });

  it("writes the plain format when the setting says json", async () => {
    const store = await open("json");
    assert.ok(await store.add(annotation("one")));
    assert.ok(fs.existsSync(jsonPath));
    assert.ok(!fs.existsSync(gzPath));
    assert.equal(store.location?.fsPath, jsonPath);
    assert.deepEqual(ids(store), ["one"]);
  });

  it("writes the compressed format when the setting says compressed", async () => {
    const store = await open("compressed");
    assert.ok(await store.add(annotation("one")));
    assert.ok(fs.existsSync(gzPath));
    assert.ok(!fs.existsSync(jsonPath));
    assert.ok(compressedText().includes('"one"'));
  });

  it("reads back what another window wrote", async () => {
    const writer = await open("json");
    assert.ok(await writer.add(annotation("one")));
    const reader = await open("json");
    assert.deepEqual(ids(reader), ["one"]);
    assert.equal(reader.location?.fsPath, jsonPath);
  });

  it("updates and removes an annotation", async () => {
    const store = await open("json");
    assert.ok(await store.add(annotation("one")));
    assert.ok(await store.update("one", (entry) => ({ ...entry, color: "green" })));
    assert.equal(store.byId("one")?.color, "green");
    assert.equal(await store.update("missing", (entry) => entry), false);
    assert.deepEqual(
      store.forFile("src/a.ts").map((entry) => entry.id),
      ["one"]
    );
    assert.deepEqual(store.forFile("src/b.ts"), []);
    assert.ok(await store.remove("one"));
    assert.equal(await store.remove("one"), false);
    assert.deepEqual(ids(store), []);
  });
});

describe("the file on disk decides the format", () => {
  it("loads the compressed file while the setting says json", async () => {
    const store = await open("compressed");
    assert.ok(await store.add(annotation("one")));
    setConfiguration("codelight.storage", "json");
    await store.refresh();
    assert.deepEqual(ids(store), ["one"]);
    assert.ok(!fs.existsSync(jsonPath));
  });

  it("writes back to the compressed file while the setting says json", async () => {
    const store = await open("compressed");
    assert.ok(await store.add(annotation("one")));
    setConfiguration("codelight.storage", "json");
    await store.refresh();
    assert.ok(await store.add(annotation("two")));
    assert.ok(!fs.existsSync(jsonPath));
    assert.ok(compressedText().includes('"two"'));
    assert.deepEqual(ids(store), ["one", "two"]);
  });

  it("follows the newer file when both formats exist", async () => {
    const store = await open("json");
    assert.ok(await store.add(annotation("plain")));
    fs.writeFileSync(gzPath, gzipSync(Buffer.from(fs.readFileSync(jsonPath))));
    age(gzPath, -60);
    await store.refresh();
    assert.equal(store.location?.fsPath, jsonPath);
    age(gzPath, 60);
    await store.refresh();
    assert.equal(store.location?.fsPath, gzPath);
  });

  it("warns once about a duplicate and names both files", async () => {
    const store = await open("json");
    assert.ok(await store.add(annotation("plain")));
    fs.writeFileSync(gzPath, gzipSync(Buffer.from(fs.readFileSync(jsonPath))));
    age(gzPath, -60);
    messages.length = 0;
    await store.refresh();
    await store.refresh();
    const seen = warnings().filter((entry) => entry.includes(jsonPath) && entry.includes(gzPath));
    assert.equal(seen.length, 1);
    assert.ok(seen[0].includes(`It is using ${jsonPath}`));
  });

  it("leaves the file it is not using alone", async () => {
    const store = await open("json");
    assert.ok(await store.add(annotation("plain")));
    const stray = gzipSync(Buffer.from('{"version":1,"annotations":[]}\n', "utf8"));
    fs.writeFileSync(gzPath, stray);
    age(gzPath, -60);
    await store.refresh();
    assert.ok(await store.add(annotation("second")));
    assert.deepEqual(ids(store), ["plain", "second"]);
    assert.deepEqual(fs.readFileSync(gzPath), stray);
  });
});

describe("converting between the formats", () => {
  it("converts the plain file into the compressed one", async () => {
    const store = await open("json");
    assert.ok(await store.add(annotation("one")));
    const before = plainText();
    queueAnswer("Convert");
    assert.equal(await store.convertStorage(), true);
    assert.ok(!fs.existsSync(jsonPath));
    assert.equal(compressedText(), before);
    assert.equal(store.location?.fsPath, gzPath);
    assert.deepEqual(ids(store), ["one"]);
    await store.refresh();
    assert.deepEqual(ids(store), ["one"]);
  });

  it("converts the compressed file back into the plain one", async () => {
    const store = await open("compressed");
    assert.ok(await store.add(annotation("one")));
    const before = compressedText();
    queueAnswer("Convert");
    assert.equal(await store.convertStorage(), true);
    assert.ok(!fs.existsSync(gzPath));
    assert.equal(plainText(), before);
    assert.deepEqual(ids(store), ["one"]);
  });

  it("names both files in the question and does nothing without an answer", async () => {
    const store = await open("json");
    assert.ok(await store.add(annotation("one")));
    messages.length = 0;
    assert.equal(await store.convertStorage(), false);
    assert.ok(fs.existsSync(jsonPath));
    assert.ok(!fs.existsSync(gzPath));
    const asked = warnings().find((entry) => entry.includes("Convert "));
    assert.ok(asked);
    assert.ok(asked.includes(jsonPath) && asked.includes(gzPath));
    assert.ok(asked.includes("git cannot diff or merge it"));
  });

  it("refuses while both files exist", async () => {
    const store = await open("json");
    assert.ok(await store.add(annotation("one")));
    fs.writeFileSync(gzPath, gzipSync(Buffer.from(fs.readFileSync(jsonPath))));
    messages.length = 0;
    assert.equal(await store.convertStorage(), false);
    assert.ok(fs.existsSync(jsonPath) && fs.existsSync(gzPath));
    assert.ok(warnings().some((entry) => entry.includes("Remove the one you do not want")));
  });

  it("refuses when there is nothing to convert", async () => {
    const store = await open("json");
    messages.length = 0;
    assert.equal(await store.convertStorage(), false);
    assert.deepEqual(entries(), []);
    assert.ok(messages.some((entry) => entry.includes("no annotation file to convert")));
  });

  it("refuses a store that is a symlink", async () => {
    const store = await open("compressed");
    assert.ok(await store.add(annotation("one")));
    const real = nodePath.join(root, "store.json.gz");
    fs.renameSync(gzPath, real);
    fs.symlinkSync(real, gzPath);
    messages.length = 0;
    assert.equal(await store.convertStorage(), false);
    assert.ok(fs.lstatSync(gzPath).isSymbolicLink());
    assert.ok(!fs.existsSync(jsonPath));
    assert.ok(warnings().some((entry) => entry.includes(gzPath) && entry.includes("symlink")));
  });

  it("rolls back when the destination cannot be read back", async () => {
    const store = await open("json");
    assert.ok(await store.add(annotation("one")));
    faults.corruptTemp = true;
    queueAnswer("Convert");
    messages.length = 0;
    assert.equal(await store.convertStorage(), false);
    assert.ok(fs.existsSync(jsonPath));
    assert.ok(!fs.existsSync(gzPath));
    assert.ok(errors().some((entry) => entry.includes("read back") && entry.includes(gzPath)));
    clearFaults();
    assert.deepEqual(ids(store), ["one"]);
  });

  it("rolls back when the source cannot be removed", async () => {
    const store = await open("json");
    assert.ok(await store.add(annotation("one")));
    faults.deletePath = jsonPath;
    queueAnswer("Convert");
    messages.length = 0;
    assert.equal(await store.convertStorage(), false);
    assert.ok(fs.existsSync(jsonPath));
    assert.ok(!fs.existsSync(gzPath));
    assert.ok(errors().some((entry) => entry.includes("could not remove") && entry.includes(jsonPath)));
  });

  it("keeps the source when the write fails", async () => {
    const store = await open("json");
    assert.ok(await store.add(annotation("one")));
    faults.interruptWrite = true;
    queueAnswer("Convert");
    messages.length = 0;
    assert.equal(await store.convertStorage(), false);
    assert.ok(fs.existsSync(jsonPath));
    assert.ok(!fs.existsSync(gzPath));
    assert.deepEqual(entries(), ["codelight.json"]);
    assert.ok(errors().some((entry) => entry.includes(gzPath)));
  });

  it("refuses a store that is over the size limit", async () => {
    const store = await open("json");
    assert.ok(await store.add(annotation("one")));
    fs.writeFileSync(jsonPath, JSON.stringify({ version: 1, annotations: [bulky("big")] }));
    queueAnswer("Convert");
    messages.length = 0;
    assert.equal(await store.convertStorage(), false);
    assert.ok(fs.existsSync(jsonPath));
    assert.ok(!fs.existsSync(gzPath));
    assert.ok(errors().some((entry) => entry.includes("MB limit") && entry.includes(jsonPath)));
  });

  it("refuses while it cannot check both files", async () => {
    const store = await open("json");
    assert.ok(await store.add(annotation("one")));
    faults.statPath = gzPath;
    messages.length = 0;
    assert.equal(await store.convertStorage(), false);
    assert.ok(warnings().some((entry) => entry.includes("could not check both annotation files")));
    assert.deepEqual(entries(), ["codelight.json"]);
  });

  it("reports a check it could not make on the destination", async () => {
    const store = await open("json");
    assert.ok(await store.add(annotation("one")));
    faults.statPath = gzPath;
    faults.statSkip = 1;
    queueAnswer("Convert");
    messages.length = 0;
    assert.equal(await store.convertStorage(), false);
    assert.ok(errors().some((entry) => entry.includes("could not check") && entry.includes(gzPath)));
    assert.deepEqual(entries(), ["codelight.json"]);
  });
});

describe("writing atomically", () => {
  it("replaces the file through a temporary one", async () => {
    const store = await open("json");
    assert.ok(await store.add(annotation("one")));
    const first = fs.statSync(jsonPath).ino;
    assert.ok(await store.add(annotation("two")));
    assert.notEqual(fs.statSync(jsonPath).ino, first);
    assert.deepEqual(entries(), ["codelight.json"]);
  });

  it("keeps the permissions of the file it replaces", async () => {
    const store = await open("json");
    assert.ok(await store.add(annotation("one")));
    fs.chmodSync(jsonPath, 0o664);
    assert.ok(await store.add(annotation("two")));
    assert.equal(fs.statSync(jsonPath).mode & 0o777, 0o664);
  });

  it("writes a hard linked store in place", async () => {
    const store = await open("json");
    assert.ok(await store.add(annotation("one")));
    const other = nodePath.join(root, "shared.json");
    fs.linkSync(jsonPath, other);
    const shared = fs.statSync(jsonPath).ino;
    assert.ok(await store.add(annotation("two")));
    assert.equal(fs.statSync(jsonPath).ino, shared);
    assert.equal(fs.readFileSync(other, "utf8"), plainText());
  });

  it("writes a symlinked store through the link", async () => {
    const store = await open("compressed");
    assert.ok(await store.add(annotation("one")));
    const real = nodePath.join(root, "store.json.gz");
    fs.renameSync(gzPath, real);
    fs.symlinkSync(real, gzPath);
    assert.ok(await store.add(annotation("two")));
    assert.ok(fs.lstatSync(gzPath).isSymbolicLink());
    assert.ok(gunzipSync(fs.readFileSync(real)).toString("utf8").includes('"two"'));
    await store.refresh();
    assert.deepEqual(ids(store), ["one", "two"]);
  });

  it("leaves the plain store intact when the write is interrupted", async () => {
    const store = await open("json");
    assert.ok(await store.add(annotation("one")));
    const before = plainText();
    faults.interruptWrite = true;
    messages.length = 0;
    assert.equal(await store.add(annotation("two")), false);
    assert.equal(plainText(), before);
    assert.deepEqual(entries(), ["codelight.json"]);
    const failure = errors()[0];
    assert.ok(failure);
    assert.ok(failure.includes(jsonPath));
    assert.ok(!failure.includes(".tmp"));
    clearFaults();
    await store.refresh();
    assert.deepEqual(ids(store), ["one"]);
  });

  it("leaves the compressed store intact when the write is interrupted", async () => {
    const store = await open("compressed");
    assert.ok(await store.add(annotation("one")));
    const before = fs.readFileSync(gzPath);
    faults.interruptWrite = true;
    assert.equal(await store.add(annotation("two")), false);
    assert.deepEqual(fs.readFileSync(gzPath), before);
    assert.deepEqual(entries(), ["codelight.json.gz"]);
    clearFaults();
    await store.refresh();
    assert.deepEqual(ids(store), ["one"]);
  });

  it("falls back to an in place write and warns once", READ_ONLY_FOLDER, async () => {
    const store = await open("json");
    assert.ok(await store.add(annotation("one")));
    const before = fs.statSync(jsonPath).ino;
    fs.chmodSync(vscodeDir, 0o500);
    messages.length = 0;
    const first = await store.add(annotation("two"));
    const second = await store.add(annotation("three"));
    fs.chmodSync(vscodeDir, 0o700);
    assert.ok(first);
    assert.ok(second);
    assert.equal(fs.statSync(jsonPath).ino, before);
    assert.deepEqual(entries(), ["codelight.json"]);
    assert.equal(warnings().filter((entry) => entry.includes("truncate")).length, 1);
    await store.refresh();
    assert.deepEqual(ids(store), ["one", "three", "two"]);
  });

  it("refuses a compressed store that grows past the limit", async () => {
    const store = await open("compressed");
    assert.ok(await store.add(annotation("small")));
    const before = fs.readFileSync(gzPath);
    messages.length = 0;
    assert.equal(await store.add(bulky("huge")), false);
    assert.deepEqual(fs.readFileSync(gzPath), before);
    assert.deepEqual(entries(), ["codelight.json.gz"]);
    assert.ok(errors().some((entry) => entry.includes(gzPath) && entry.includes("64 MB")));
    await store.refresh();
    assert.deepEqual(ids(store), ["small"]);
  });

  it("sends concurrent writes through the queue", async () => {
    const store = await open("json");
    const saved = await Promise.all([
      store.add(annotation("one")),
      store.add(annotation("two")),
      store.add(annotation("three")),
      store.add(annotation("four"))
    ]);
    assert.deepEqual(saved, [true, true, true, true]);
    assert.deepEqual(ids(store), ["four", "one", "three", "two"]);
    assert.deepEqual(entries(), ["codelight.json"]);
    const reader = await open("json");
    assert.deepEqual(ids(reader), ["four", "one", "three", "two"]);
  });

  it("keeps a transaction that changes nothing off the disk", async () => {
    const store = await open("json");
    assert.ok(await store.add(annotation("one")));
    const before = fs.statSync(jsonPath).mtimeMs;
    assert.equal(await store.transaction(() => false), false);
    assert.equal(fs.statSync(jsonPath).mtimeMs, before);
  });
});

describe("sweeping temporary files", () => {
  it("removes a stale temporary file and keeps a fresh one", async () => {
    const stale = nodePath.join(vscodeDir, "codelight.write-old.tmp");
    const busy = nodePath.join(vscodeDir, "codelight.write-new.tmp");
    const bystander = nodePath.join(vscodeDir, "settings.json");
    fs.writeFileSync(stale, "half a store");
    fs.writeFileSync(busy, "another window is writing this");
    fs.writeFileSync(bystander, "{}");
    age(stale, -30 * 60);
    age(bystander, -30 * 60);
    const store = await open("json");
    assert.ok(store.isReady);
    assert.deepEqual(entries(), ["codelight.write-new.tmp", "settings.json"]);
  });

  it("removes a temporary file left behind after the next write", async () => {
    const store = await open("json");
    assert.ok(await store.add(annotation("one")));
    const late = nodePath.join(vscodeDir, "codelight.write-late.tmp");
    fs.writeFileSync(late, "left by an interrupted save");
    age(late, -30 * 60);
    assert.ok(await store.add(annotation("two")));
    await settle(() => !fs.existsSync(late));
    assert.deepEqual(entries(), ["codelight.json"]);
  });
});

describe("a store it cannot read", () => {
  it("keeps the annotations when the file becomes invalid JSON", async () => {
    const store = await open("json");
    assert.ok(await store.add(annotation("one")));
    fs.writeFileSync(jsonPath, "{ not json");
    messages.length = 0;
    await store.refresh();
    assert.deepEqual(ids(store), ["one"]);
    assert.ok(errors().some((entry) => entry.includes(jsonPath)));
    assert.equal(plainText(), "{ not json");
  });

  it("keeps the annotations when the compressed file is not gzip", async () => {
    const store = await open("compressed");
    assert.ok(await store.add(annotation("one")));
    fs.writeFileSync(gzPath, Buffer.from("not gzip at all", "utf8"));
    messages.length = 0;
    await store.refresh();
    assert.deepEqual(ids(store), ["one"]);
    assert.ok(errors().some((entry) => entry.includes(gzPath)));
  });

  it("refuses an archive that inflates past the limit", async () => {
    const store = await open("compressed");
    assert.ok(await store.add(annotation("one")));
    fs.writeFileSync(gzPath, gzipSync(Buffer.alloc(LIMIT + 1024, 32)));
    messages.length = 0;
    await store.refresh();
    assert.deepEqual(ids(store), ["one"]);
    assert.ok(errors().some((entry) => entry.includes(gzPath)));
    assert.ok(fs.existsSync(gzPath));
  });

  it("refuses a plain file past the limit", async () => {
    const store = await open("json");
    assert.ok(await store.add(annotation("one")));
    fs.writeFileSync(jsonPath, Buffer.alloc(LIMIT + 1024, 32));
    messages.length = 0;
    await store.refresh();
    assert.deepEqual(ids(store), ["one"]);
    assert.ok(errors().some((entry) => entry.includes(jsonPath) && entry.includes("MB limit")));
    assert.ok(fs.existsSync(jsonPath));
  });

  it("refuses a version that is not a number", async () => {
    const store = await open("json");
    assert.ok(await store.add(annotation("one")));
    fs.writeFileSync(jsonPath, JSON.stringify({ version: "1", annotations: [] }));
    messages.length = 0;
    await store.refresh();
    assert.deepEqual(ids(store), ["one"]);
    assert.ok(errors().some((entry) => entry.includes("not a number")));
  });

  it("refuses a file from a newer build", async () => {
    const store = await open("json");
    assert.ok(await store.add(annotation("one")));
    fs.writeFileSync(jsonPath, JSON.stringify({ version: 99, annotations: [] }));
    messages.length = 0;
    await store.refresh();
    assert.deepEqual(ids(store), ["one"]);
    assert.ok(errors().some((entry) => entry.includes("format version 99")));
  });

  it("warns once about the entries it skipped", async () => {
    const store = await open("json");
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({ version: 1, annotations: [annotation("one"), "junk", { id: "", file: "a.ts" }] })
    );
    messages.length = 0;
    await store.refresh();
    await store.refresh();
    assert.deepEqual(ids(store), ["one"]);
    const skipped = warnings().filter((entry) => entry.includes("skipped 2 unreadable entries"));
    assert.equal(skipped.length, 1);
  });

  it("keeps the entries it skipped in the file", async () => {
    const store = await open("json");
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({ version: 1, annotations: [annotation("one"), { id: "junk", file: "../escape" }] })
    );
    await store.refresh();
    assert.ok(await store.add(annotation("two")));
    const written = JSON.parse(plainText()) as { annotations: Array<{ id: string }> };
    assert.deepEqual(
      written.annotations.map((entry) => entry.id),
      ["one", "two", "junk"]
    );
  });

  it("catches up when a change it cannot apply finds a newer file", async () => {
    const store = await open("json");
    assert.ok(await store.add(annotation("one")));
    fs.writeFileSync(jsonPath, JSON.stringify({ version: 1, annotations: [annotation("two")] }));
    assert.equal(await store.remove("missing"), false);
    await settle(() => ids(store).length === 1 && ids(store)[0] === "two");
    assert.deepEqual(ids(store), ["two"]);
  });

  it("empties the annotations when the file disappears", async () => {
    const store = await open("json");
    assert.ok(await store.add(annotation("one")));
    fs.rmSync(jsonPath);
    await store.refresh();
    assert.deepEqual(ids(store), []);
    assert.equal(store.location, undefined);
  });
});

describe("a check it cannot make", () => {
  it("uses the file it can confirm", async () => {
    const store = await open("compressed");
    assert.ok(await store.add(annotation("one")));
    faults.statPath = jsonPath;
    messages.length = 0;
    await store.refresh();
    assert.deepEqual(ids(store), ["one"]);
    assert.deepEqual(messages, []);
    assert.ok(await store.add(annotation("two")));
    assert.ok(!fs.existsSync(jsonPath));
    assert.deepEqual(ids(store), ["one", "two"]);
  });

  it("keeps the annotations when the store itself cannot be checked", async () => {
    const store = await open("compressed");
    assert.ok(await store.add(annotation("one")));
    faults.statPath = gzPath;
    messages.length = 0;
    await store.refresh();
    assert.deepEqual(ids(store), ["one"]);
    assert.ok(await store.add(annotation("two")));
    assert.ok(!fs.existsSync(jsonPath));
  });

  it("refuses to guess in a fresh window", async () => {
    const writer = await open("compressed");
    assert.ok(await writer.add(annotation("one")));
    faults.statPath = gzPath;
    messages.length = 0;
    const guard = await open("json");
    assert.deepEqual(ids(guard), []);
    assert.equal(await guard.add(annotation("two")), false);
    assert.ok(!fs.existsSync(jsonPath));
    assert.ok(errors().some((entry) => entry.includes(gzPath)));
    clearFaults();
    await guard.refresh();
    assert.deepEqual(ids(guard), ["one"]);
  });
});

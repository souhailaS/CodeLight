import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { messages, queueAnswer, resetFake, Uri, warnings, workspace } from "./fakevscode";
import { mergeSides, sidesOf } from "../src/conflict";
import { Annotation, hasConflict, parseStore, serializeStore } from "../src/model";
import { AnnotationStore } from "../src/store";

let root = "";
let closing: Array<{ dispose(): void }> = [];

function annotation(id: string, file: string, updatedAt = "2026-08-01T00:00:00.000Z"): Annotation {
  return {
    id,
    file,
    range: { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 5 },
    anchor: { text: "const", before: "", after: "" },
    color: "yellow",
    author: { login: "ada", id: "42" },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt,
    comments: []
  };
}

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function conflicted(mine: Annotation[], theirs: Annotation[]): string {
  const repo = fs.mkdtempSync(nodePath.join(os.tmpdir(), "codelight-merge-"));
  const file = nodePath.join(repo, "codelight.json");
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "a@b.c"], repo);
  git(["config", "user.name", "ada"], repo);
  fs.writeFileSync(file, serializeStore([annotation("base", "src/base.ts")]));
  git(["add", "."], repo);
  git(["commit", "-qm", "base"], repo);
  git(["checkout", "-qb", "theirs"], repo);
  fs.writeFileSync(file, serializeStore([annotation("base", "src/base.ts"), ...theirs]));
  git(["commit", "-qam", "theirs"], repo);
  git(["checkout", "-q", "main"], repo);
  fs.writeFileSync(file, serializeStore([annotation("base", "src/base.ts"), ...mine]));
  git(["commit", "-qam", "mine"], repo);
  try {
    git(["merge", "theirs"], repo);
  } catch {
    // the conflict is the point
  }
  const raw = fs.readFileSync(file, "utf8");
  fs.rmSync(repo, { recursive: true, force: true });
  return raw;
}

beforeEach(() => {
  resetFake();
  closing = [];
  root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "codelight-conflict-"));
  fs.mkdirSync(nodePath.join(root, ".vscode"));
  workspace.workspaceFolders = [{ uri: Uri.file(root), name: "root", index: 0 }];
});

afterEach(() => {
  for (const item of closing) {
    item.dispose();
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("a real git conflict in the annotation file", () => {
  it("is what two people on two branches actually get", () => {
    const raw = conflicted([annotation("mine", "src/a.ts")], [annotation("theirs", "src/b.ts")]);
    assert.ok(hasConflict(raw), raw);
    assert.throws(() => parseStore(raw), /merge conflict/);
  });

  it("keeps both sides when CodeLight merges it", () => {
    const raw = conflicted([annotation("mine", "src/a.ts")], [annotation("theirs", "src/b.ts")]);
    const merged = mergeSides(raw);
    assert.ok(merged);
    assert.deepEqual(
      merged.annotations.map((entry) => entry.id).sort(),
      ["base", "mine", "theirs"]
    );
  });

  it("keeps the newer of two edits to the same note", () => {
    const raw = conflicted(
      [annotation("same", "src/a.ts", "2026-08-02T00:00:00.000Z")],
      [annotation("same", "src/b.ts", "2026-08-03T00:00:00.000Z")]
    );
    const merged = mergeSides(raw);
    assert.ok(merged);
    const same = merged.annotations.find((entry) => entry.id === "same");
    assert.equal(same?.file, "src/b.ts");
  });
});

describe("reading the two sides apart", () => {
  it("splits a diff3 conflict that carries a base section", () => {
    const raw = [
      "one",
      "<<<<<<< HEAD",
      "mine",
      "||||||| base",
      "was",
      "=======",
      "theirs",
      ">>>>>>> other",
      "two"
    ].join("\n");
    assert.deepEqual(sidesOf(raw), { mine: "one\nmine\ntwo", theirs: "one\ntheirs\ntwo" });
  });

  it("refuses a file whose markers do not nest", () => {
    assert.equal(sidesOf("<<<<<<< HEAD\nmine\n<<<<<<< HEAD\n"), undefined);
    assert.equal(sidesOf("=======\nmine\n"), undefined);
    assert.equal(sidesOf("no markers here"), undefined);
  });

  it("refuses to merge when a side is not valid JSON on its own", () => {
    const raw = ["<<<<<<< HEAD", "{not json", "=======", "{}", ">>>>>>> other"].join("\n");
    assert.equal(mergeSides(raw), undefined);
  });
});

describe("what the store does about it", () => {
  async function open(raw: string): Promise<AnnotationStore> {
    fs.writeFileSync(nodePath.join(root, ".vscode", "codelight.json"), raw);
    const store = new AnnotationStore();
    closing.push(store);
    await store.initialize();
    return store;
  }

  it("says a conflict is a conflict rather than bad json", async () => {
    const store = await open(conflicted([annotation("mine", "src/a.ts")], [annotation("theirs", "src/b.ts")]));
    assert.ok(warnings().some((line) => line.includes("unresolved merge conflict")), messages.join("\n"));
    assert.equal(warnings().some((line) => line.includes("not valid JSON")), false);
    assert.deepEqual(store.all, []);
  });

  it("merges the file when asked and reads the notes back", async () => {
    const store = await open(conflicted([annotation("mine", "src/a.ts")], [annotation("theirs", "src/b.ts")]));
    messages.length = 0;
    assert.equal(await store.resolveConflict(), true);
    assert.deepEqual(
      store.all.map((entry) => entry.id).sort(),
      ["base", "mine", "theirs"]
    );
    const written = fs.readFileSync(nodePath.join(root, ".vscode", "codelight.json"), "utf8");
    assert.equal(hasConflict(written), false);
    assert.ok(messages.some((line) => line.includes("merged the notes")));
  });

  it("can write again once the conflict is merged", async () => {
    const store = await open(conflicted([annotation("mine", "src/a.ts")], [annotation("theirs", "src/b.ts")]));
    assert.equal(await store.add(annotation("fresh", "src/c.ts")), false);
    assert.equal(await store.resolveConflict(), true);
    assert.equal(await store.add(annotation("fresh", "src/c.ts")), true);
    assert.ok(store.byId("fresh"));
  });

  it("leaves a conflict it cannot read alone", async () => {
    const store = await open(["<<<<<<< HEAD", "{not json", "=======", "{}", ">>>>>>> other"].join("\n"));
    messages.length = 0;
    assert.equal(await store.resolveConflict(), false);
    assert.ok(warnings().some((line) => line.includes("could not make sense")));
    const written = fs.readFileSync(nodePath.join(root, ".vscode", "codelight.json"), "utf8");
    assert.ok(hasConflict(written));
  });

  it("says so when there was no conflict to merge", async () => {
    const store = await open(serializeStore([annotation("one", "src/a.ts")]));
    messages.length = 0;
    queueAnswer("");
    assert.equal(await store.resolveConflict(), true);
    assert.ok(messages.some((line) => line.includes("no merge conflict left")));
  });
});

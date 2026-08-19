import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  foldersChanged,
  invoked,
  messages,
  queueAnswer,
  resetFake,
  Uri,
  warnings,
  workspace
} from "./fakevscode";
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

const SOLO = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0"
};

function usable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const NEEDS_GIT = { skip: usable() ? false : "these tests need git on the path" };

function git(args: string[], cwd: string, style = "merge"): void {
  execFileSync("git", ["-c", "commit.gpgsign=false", `-c`, `merge.conflictStyle=${style}`, ...args], {
    cwd,
    stdio: "ignore",
    env: { ...process.env, ...SOLO }
  });
}

const BASE = annotation("base", "src/base.ts");

function conflicted(mine: Annotation[], theirs: Annotation[], style = "merge"): string {
  const repo = fs.mkdtempSync(nodePath.join(os.tmpdir(), "codelight-merge-"));
  const file = nodePath.join(repo, "codelight.json");
  try {
    return build(repo, file, mine, theirs, style);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

function build(
  repo: string,
  file: string,
  mine: Annotation[],
  theirs: Annotation[],
  style: string
): string {
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "a@b.c"], repo);
  git(["config", "user.name", "ada"], repo);
  fs.writeFileSync(file, serializeStore([annotation("base", "src/base.ts")]));
  git(["add", "."], repo);
  git(["commit", "-qm", "base"], repo);
  git(["checkout", "-qb", "theirs"], repo);
  fs.writeFileSync(file, serializeStore(theirs));
  git(["commit", "-qam", "theirs"], repo);
  git(["checkout", "-q", "main"], repo);
  fs.writeFileSync(file, serializeStore(mine));
  git(["commit", "-qam", "mine"], repo);
  try {
    git(["merge", "theirs"], repo, style);
  } catch {
    // the conflict is the point
  }
  return fs.readFileSync(file, "utf8");
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

describe("a real git conflict in the annotation file", NEEDS_GIT, () => {
  it("is what two people on two branches actually get", () => {
    const raw = conflicted([BASE, annotation("mine", "src/a.ts")], [BASE, annotation("theirs", "src/b.ts")]);
    assert.ok(hasConflict(raw), raw);
    assert.throws(() => parseStore(raw), /merge conflict/);
  });

  it("keeps both sides when CodeLight merges it", () => {
    const raw = conflicted([BASE, annotation("mine", "src/a.ts")], [BASE, annotation("theirs", "src/b.ts")]);
    const merged = mergeSides(raw);
    assert.ok(merged);
    assert.deepEqual(
      merged.annotations.map((entry) => entry.id).sort(),
      ["base", "mine", "theirs"]
    );
  });

  it("keeps the newer of two edits to the same note", () => {
    const raw = conflicted(
      [BASE, annotation("same", "src/a.ts", "2026-08-02T00:00:00.000Z")],
      [BASE, annotation("same", "src/b.ts", "2026-08-03T00:00:00.000Z")]
    );
    const merged = mergeSides(raw);
    assert.ok(merged);
    const same = merged.annotations.find((entry) => entry.id === "same");
    assert.equal(same?.file, "src/b.ts");
  });
});

describe("what git's own default conflict style gives us", () => {
  it("merges both sides whichever style git used", NEEDS_GIT, () => {
    for (const style of ["merge", "diff3", "zdiff3"]) {
      const raw = conflicted(
        [BASE, annotation("mine", "src/a.ts")],
        [BASE, annotation("theirs", "src/b.ts")],
        style
      );
      const merged = mergeSides(raw);
      assert.ok(merged, style);
      assert.deepEqual(
        merged.annotations.map((entry) => entry.id).sort(),
        ["base", "mine", "theirs"],
        style
      );
      assert.equal(merged.sawBase, style !== "merge", style);
    }
  });

  it("says it cannot know about deletions when git gave it no base", NEEDS_GIT, () => {
    const raw = conflicted([BASE, annotation("mine", "src/a.ts")], [], "merge");
    const merged = mergeSides(raw);
    assert.ok(merged);
    assert.equal(merged.sawBase, false);
    assert.ok(merged.annotations.some((entry) => entry.id === "base"));
  });

  it("honours a deletion when git gave it the base", NEEDS_GIT, () => {
    const raw = conflicted([BASE, annotation("mine", "src/a.ts")], [], "diff3");
    const merged = mergeSides(raw);
    assert.ok(merged);
    assert.equal(merged.sawBase, true);
    assert.equal(merged.annotations.some((entry) => entry.id === "base"), false);
    assert.ok(merged.dropped > 0);
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
    assert.deepEqual(sidesOf(raw), {
      mine: "one\nmine\ntwo",
      theirs: "one\ntheirs\ntwo",
      base: "one\nwas\ntwo"
    });
  });

  it("refuses a file whose markers do not nest", () => {
    assert.equal(sidesOf("<<<<<<< HEAD\nmine\n<<<<<<< HEAD\n"), undefined);
    assert.equal(sidesOf("=======\nmine\n"), undefined);
    assert.equal(sidesOf("no markers here"), undefined);
  });

  it("merges anyway when only the base section is unreadable", () => {
    const mine = JSON.stringify({ version: 1, annotations: [] }, null, 2);
    const raw = [
      "<<<<<<< HEAD",
      mine,
      "||||||| base",
      "{ not json at all",
      "=======",
      JSON.stringify({ version: 1, annotations: [] }, null, 2),
      ">>>>>>> other"
    ].join("\n");
    const merged = mergeSides(raw);
    assert.ok(merged);
    assert.equal(merged.sawBase, false);
  });

  it("writes an entry it could not read only once", () => {
    const weird = { id: "weird", nope: true };
    const side = JSON.stringify({ version: 1, annotations: [weird] }, null, 2);
    const raw = ["<<<<<<< HEAD", side, "=======", side, ">>>>>>> other"].join("\n");
    const merged = mergeSides(raw);
    assert.ok(merged);
    assert.equal(merged.rejected.length, 1);
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

  it("says a conflict is a conflict rather than bad json", NEEDS_GIT, async () => {
    const store = await open(conflicted([BASE, annotation("mine", "src/a.ts")], [BASE, annotation("theirs", "src/b.ts")]));
    assert.ok(warnings().some((line) => line.includes("unresolved merge conflict")), messages.join("\n"));
    assert.equal(warnings().some((line) => line.includes("not valid JSON")), false);
    assert.deepEqual(store.all, []);
  });

  it("merges the file when asked and reads the notes back", NEEDS_GIT, async () => {
    const store = await open(conflicted([BASE, annotation("mine", "src/a.ts")], [BASE, annotation("theirs", "src/b.ts")]));
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

  it("can write again once the conflict is merged", NEEDS_GIT, async () => {
    const store = await open(conflicted([BASE, annotation("mine", "src/a.ts")], [BASE, annotation("theirs", "src/b.ts")]));
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
    assert.equal(await store.resolveConflict(), false);
    assert.ok(messages.some((line) => line.includes("no merge conflict to put back together")));
  });

  it("keeps a note the other side deleted deleted", async () => {
    const store = await open(
      [
        "<<<<<<< HEAD",
        serializeStore([annotation("base", "src/base.ts"), annotation("mine", "src/a.ts")]).trimEnd(),
        "||||||| base",
        serializeStore([annotation("base", "src/base.ts")]).trimEnd(),
        "=======",
        serializeStore([]).trimEnd(),
        ">>>>>>> other"
      ].join("\n")
    );
    messages.length = 0;
    assert.equal(await store.resolveConflict(), true);
    assert.deepEqual(
      store.all.map((entry) => entry.id).sort(),
      ["mine"]
    );
    assert.ok(messages.some((line) => line.includes("stayed deleted")));
  });

  it("keeps the entries the parser could not read", async () => {
    const mine = JSON.stringify(
      { version: 1, annotations: [annotation("mine", "src/a.ts"), { id: "weird", nope: true }] },
      null,
      2
    );
    const theirs = JSON.stringify({ version: 1, annotations: [annotation("theirs", "src/b.ts")] }, null, 2);
    const store = await open(["<<<<<<< HEAD", mine, "=======", theirs, ">>>>>>> other"].join("\n"));
    assert.equal(await store.resolveConflict(), true);
    const written = fs.readFileSync(nodePath.join(root, ".vscode", "codelight.json"), "utf8");
    assert.ok(written.includes('"weird"'), written);
    assert.deepEqual(
      store.all.map((entry) => entry.id).sort(),
      ["mine", "theirs"]
    );
  });

  it("keeps claiming a conflict while another folder still has one", NEEDS_GIT, async () => {
    const clean = fs.mkdtempSync(nodePath.join(os.tmpdir(), "codelight-clean-"));
    fs.mkdirSync(nodePath.join(clean, ".vscode"));
    fs.writeFileSync(
      nodePath.join(clean, ".vscode", "codelight.json"),
      serializeStore([annotation("fine", "src/ok.ts")])
    );
    workspace.workspaceFolders = [
      { uri: Uri.file(root), name: "root", index: 0 },
      { uri: Uri.file(clean), name: "clean", index: 1 }
    ];
    const store = await open(
      conflicted([BASE, annotation("mine", "src/a.ts")], [BASE, annotation("theirs", "src/b.ts")])
    );
    const last = invoked.filter((call) => call[1] === "codelight.conflicted").pop();
    assert.deepEqual(last?.[2], true, JSON.stringify(invoked));
    assert.deepEqual(
      store.all.map((entry) => entry.id),
      ["fine"]
    );
    fs.rmSync(clean, { recursive: true, force: true });
  });

  it("stops claiming a conflict when the file goes back to what it held", NEEDS_GIT, async () => {
    const start = serializeStore([annotation("mine", "src/a.ts")]);
    const store = await open(start);
    assert.equal(store.all.length, 1);
    fs.writeFileSync(
      nodePath.join(root, ".vscode", "codelight.json"),
      conflicted([BASE, annotation("mine", "src/a.ts")], [BASE, annotation("theirs", "src/b.ts")])
    );
    await store.refresh();
    assert.equal(store.all.length, 1);
    invoked.length = 0;
    fs.writeFileSync(nodePath.join(root, ".vscode", "codelight.json"), start);
    await store.refresh();
    const last = invoked.filter((call) => call[1] === "codelight.conflicted").pop();
    assert.deepEqual(last?.[2], false, JSON.stringify(invoked));
  });

  it("stops claiming a conflict once a folder leaves the workspace", NEEDS_GIT, async () => {
    const store = await open(
      conflicted([BASE, annotation("mine", "src/a.ts")], [BASE, annotation("theirs", "src/b.ts")])
    );
    assert.equal(store.folders.some((folder) => folder.conflicted), true);
    workspace.workspaceFolders = [];
    foldersChanged.fire();
    const told = () => invoked.filter((call) => call[1] === "codelight.conflicted").pop()?.[2];
    for (let attempt = 0; attempt < 100 && told() !== false; attempt += 1) {
      await new Promise((done) => setTimeout(done, 10));
    }
    assert.equal(told(), false, JSON.stringify(invoked));
  });

  it("says nothing reassuring when it could not make sense of the conflict", async () => {
    const store = await open(["<<<<<<< HEAD", "{not json", "=======", "{}", ">>>>>>> other"].join("\n"));
    messages.length = 0;
    assert.equal(await store.resolveConflict(), false);
    assert.equal(
      messages.some((line) => line.includes("no merge conflict to put back together")),
      false
    );
  });

  it("stops claiming a conflict once the file is fixed by hand", NEEDS_GIT, async () => {
    const store = await open(conflicted([BASE, annotation("mine", "src/a.ts")], [BASE, annotation("theirs", "src/b.ts")]));
    assert.equal(store.all.length, 0);
    fs.writeFileSync(
      nodePath.join(root, ".vscode", "codelight.json"),
      serializeStore([annotation("byhand", "src/c.ts")])
    );
    invoked.length = 0;
    await store.refresh();
    assert.deepEqual(
      store.all.map((entry) => entry.id),
      ["byhand"]
    );
    assert.ok(
      invoked.some((call) => call[1] === "codelight.conflicted" && call[2] === false),
      JSON.stringify(invoked)
    );
  });
});

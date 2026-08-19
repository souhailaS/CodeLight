import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { messages, resetFake, Uri, workspace } from "./fakevscode";
import { Identity } from "../src/identity";
import { Annotation } from "../src/model";
import { SignInNudge } from "../src/nudge";
import { SharingState } from "../src/sharing";
import { AnnotationStore } from "../src/store";

let root = "";
let closing: Array<{ dispose(): void }> = [];
let answers: Record<string, number | undefined> = {};

function local(source: Identity["source"] = "git"): Identity {
  return { login: "Ada Lovelace", id: "local:abc", avatarUrl: "", verified: false, source };
}

function annotation(id: string): Annotation {
  return {
    id,
    file: "src/a.ts",
    range: { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 5 },
    anchor: { text: "const", before: "", after: "" },
    color: "yellow",
    author: { login: "ada", id: "42" },
    createdAt: "t",
    updatedAt: "t",
    comments: [],
    root: Uri.file(root).toString()
  };
}

async function rig(): Promise<{ store: AnnotationStore; nudge: SignInNudge }> {
  const store = new AnnotationStore();
  await store.initialize();
  assert.ok(await store.add(annotation("one")));
  const sharing = new SharingState((args) =>
    Promise.resolve(args[0] in answers ? answers[args[0]] : 1)
  );
  closing.push(store);
  return { store, nudge: new SignInNudge(store, sharing) };
}

function at(): Uri {
  return Uri.file(nodePath.join(root, "src/a.ts"));
}

function said(): string[] {
  return messages.filter((entry) => entry.startsWith("info "));
}

beforeEach(() => {
  resetFake();
  closing = [];
  answers = { "rev-parse": 0, "check-ignore": 1, "ls-files": 0 };
  root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "codelight-nudge-"));
  fs.mkdirSync(nodePath.join(root, ".vscode"));
  workspace.workspaceFolders = [{ uri: Uri.file(root), name: "root", index: 0 }];
});

afterEach(() => {
  for (const item of closing) {
    item.dispose();
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("telling someone their name is not verified", () => {
  it("says so when git carries the annotation file", async () => {
    const { nudge } = await rig();
    await nudge.about(at(), local());
    assert.equal(said().length, 1);
    assert.ok(said()[0].includes("Ada Lovelace"), said()[0]);
    assert.ok(said()[0].includes("git knows you by"), said()[0]);
  });

  it("says it once a window, however many notes you write", async () => {
    const { nudge } = await rig();
    await nudge.about(at(), local());
    await nudge.about(at(), local());
    assert.equal(said().length, 1);
  });

  it("says the file is not committed yet when it is not", async () => {
    answers = { "rev-parse": 0, "check-ignore": 1, "ls-files": 1 };
    const { nudge } = await rig();
    await nudge.about(at(), local());
    assert.ok(said()[0].includes("not committed yet"), said()[0]);
  });

  it("stays quiet when the notes are ignored by git", async () => {
    answers = { "rev-parse": 0, "check-ignore": 0 };
    const { nudge } = await rig();
    await nudge.about(at(), local());
    assert.deepEqual(said(), []);
  });

  it("stays quiet outside a repository", async () => {
    answers = { "rev-parse": 128 };
    const { nudge } = await rig();
    await nudge.about(at(), local());
    assert.deepEqual(said(), []);
  });

  it("stays quiet for an account github verified", async () => {
    const { nudge } = await rig();
    await nudge.about(at(), {
      login: "ada",
      id: "42",
      avatarUrl: "",
      verified: true,
      source: "github"
    });
    assert.deepEqual(said(), []);
  });

  it("names the machine account rather than pretending git knows it", async () => {
    const { nudge } = await rig();
    await nudge.about(at(), local("machine"));
    assert.ok(said()[0].includes("account name on this machine"), said()[0]);
  });
});

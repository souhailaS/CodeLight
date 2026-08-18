import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { messages, opened, queueAnswer, resetFake, Uri } from "./fakevscode";
import { keepPrivate, stopKeepingPrivate } from "../src/gitignore";

let root = "";
let ignorePath = "";

function text(): string {
  return fs.readFileSync(ignorePath, "utf8");
}

function infos(): string[] {
  return messages.filter((entry) => entry.startsWith("info "));
}

beforeEach(() => {
  resetFake();
  root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "codelight-ignore-"));
  ignorePath = nodePath.join(root, ".gitignore");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("keeping the notes out of git", () => {
  it("writes a gitignore when the folder has none", async () => {
    await keepPrivate(Uri.file(root));
    assert.equal(
      text(),
      "# CodeLight notes, kept out of git\n.vscode/codelight.json\n.vscode/codelight.json.gz\n"
    );
  });

  it("appends to what is already there", async () => {
    fs.writeFileSync(ignorePath, "node_modules\ndist\n");
    await keepPrivate(Uri.file(root));
    assert.equal(
      text(),
      "node_modules\ndist\n\n# CodeLight notes, kept out of git\n.vscode/codelight.json\n.vscode/codelight.json.gz\n"
    );
  });

  it("keeps the line endings the file already uses", async () => {
    fs.writeFileSync(ignorePath, "node_modules\r\n");
    await keepPrivate(Uri.file(root));
    assert.ok(text().includes("\r\n.vscode/codelight.json\r\n"));
    assert.equal(text().includes("\n.vscode/codelight.json\n"), false);
  });

  it("adds a final newline to a file that lacks one", async () => {
    fs.writeFileSync(ignorePath, "dist");
    await keepPrivate(Uri.file(root));
    assert.equal(
      text(),
      "dist\n\n# CodeLight notes, kept out of git\n.vscode/codelight.json\n.vscode/codelight.json.gz\n"
    );
  });

  it("says so and changes nothing when both entries are already there", async () => {
    const before = "/.vscode/codelight.json\n.vscode/codelight.json.gz\n";
    fs.writeFileSync(ignorePath, before);
    await keepPrivate(Uri.file(root));
    assert.equal(text(), before);
    assert.ok(infos().some((entry) => entry.includes("already keeps")));
  });

  it("adds only the entry that is missing", async () => {
    fs.writeFileSync(ignorePath, "# CodeLight notes, kept out of git\n.vscode/codelight.json\n");
    await keepPrivate(Uri.file(root));
    assert.equal(
      text(),
      "# CodeLight notes, kept out of git\n.vscode/codelight.json\n.vscode/codelight.json.gz\n"
    );
  });

  it("opens the file when asked", async () => {
    queueAnswer("Open .gitignore");
    await keepPrivate(Uri.file(root));
    assert.deepEqual(
      opened.map((document) => document.uri.fsPath),
      [ignorePath]
    );
  });
});

describe("letting the notes back into git", () => {
  it("removes the entries and the heading", async () => {
    fs.writeFileSync(
      ignorePath,
      "node_modules\n\n# CodeLight notes, kept out of git\n.vscode/codelight.json\n.vscode/codelight.json.gz\n"
    );
    await stopKeepingPrivate(Uri.file(root));
    assert.equal(text(), "node_modules\n");
  });

  it("leaves an empty file behind when nothing else was ignored", async () => {
    fs.writeFileSync(
      ignorePath,
      "# CodeLight notes, kept out of git\n.vscode/codelight.json\n.vscode/codelight.json.gz\n"
    );
    await stopKeepingPrivate(Uri.file(root));
    assert.equal(text(), "");
  });

  it("says so when the notes were never ignored", async () => {
    fs.writeFileSync(ignorePath, "node_modules\n");
    await stopKeepingPrivate(Uri.file(root));
    assert.equal(text(), "node_modules\n");
    assert.ok(infos().some((entry) => entry.includes("not ignored")));
  });

  it("says so when the folder has no gitignore at all", async () => {
    await stopKeepingPrivate(Uri.file(root));
    assert.equal(fs.existsSync(ignorePath), false);
    assert.ok(infos().some((entry) => entry.includes("not ignored")));
  });
});

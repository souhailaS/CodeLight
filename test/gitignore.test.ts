import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  faults,
  messages,
  opened,
  queueAnswer,
  resetFake,
  TextDocument,
  Uri,
  warnings,
  workspace
} from "./fakevscode";
import { keepPrivate, stopKeepingPrivate } from "../src/gitignore";

const UNPRIVILEGED = typeof process.getuid === "function" && process.getuid() !== 0;
const READ_ONLY_FOLDER = {
  skip: UNPRIVILEGED ? false : "a read only folder needs a user its permissions apply to"
};

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
  fs.chmodSync(root, 0o700);
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
    assert.ok(infos().some((entry) => entry.includes("already out of git")));
  });

  it("adds only the entry that is missing", async () => {
    fs.writeFileSync(ignorePath, "# CodeLight notes, kept out of git\n.vscode/codelight.json\n");
    await keepPrivate(Uri.file(root));
    assert.equal(
      text(),
      "# CodeLight notes, kept out of git\n.vscode/codelight.json\n.vscode/codelight.json.gz\n"
    );
  });

  it("keeps a mixed ending file readable", async () => {
    fs.writeFileSync(ignorePath, "node_modules\r\ndist\n");
    await keepPrivate(Uri.file(root));
    assert.equal(text().includes(".vscode/codelight.json\r\n.vscode/codelight.json.gz\r\n"), true);
    assert.equal(text().split(".vscode/codelight.json").length - 1, 2);
  });

  it("sees an entry that a mixed ending file already holds", async () => {
    fs.writeFileSync(ignorePath, "node_modules\r\ndist\n.vscode/codelight.json\n.vscode/codelight.json.gz\n");
    await keepPrivate(Uri.file(root));
    assert.ok(infos().some((entry) => entry.includes("already out of git")));
  });

  it("adds the entry again below a negation that undid it", async () => {
    fs.writeFileSync(ignorePath, ".vscode/codelight.json\n!.vscode/codelight.json\n");
    await keepPrivate(Uri.file(root));
    assert.equal(text(), ".vscode/codelight.json\n.vscode/codelight.json.gz\n");
  });

  it("refuses while the file has unsaved changes", async () => {
    fs.writeFileSync(ignorePath, "node_modules\n");
    const open = new TextDocument(Uri.file(ignorePath), "node_modules\n");
    open.isDirty = true;
    workspace.textDocuments = [open];
    await keepPrivate(Uri.file(root));
    assert.equal(text(), "node_modules\n");
    assert.ok(warnings().some((entry) => entry.includes("unsaved")));
  });

  it("replaces the file through a temporary one", async () => {
    fs.writeFileSync(ignorePath, "node_modules\n");
    const before = fs.statSync(ignorePath).ino;
    await keepPrivate(Uri.file(root));
    assert.notEqual(fs.statSync(ignorePath).ino, before);
    assert.deepEqual(
      fs.readdirSync(root).filter((name) => name.includes("tmp")),
      []
    );
  });

  it("keeps the permissions of the file it replaces", async () => {
    fs.writeFileSync(ignorePath, "node_modules\n");
    fs.chmodSync(ignorePath, 0o640);
    await keepPrivate(Uri.file(root));
    assert.equal(fs.statSync(ignorePath).mode & 0o777, 0o640);
  });

  it("leaves the file as it was when the write is interrupted", async () => {
    const before = "node_modules\ndist\n";
    fs.writeFileSync(ignorePath, before);
    faults.interruptWrite = true;
    messages.length = 0;
    await keepPrivate(Uri.file(root));
    assert.equal(text(), before);
    assert.ok(warnings().some((entry) => entry.includes(ignorePath)));
    assert.deepEqual(
      fs.readdirSync(root).filter((name) => name.endsWith(".tmp")),
      []
    );
  });

  it("says so when it has to save in place", READ_ONLY_FOLDER, async () => {
    fs.writeFileSync(ignorePath, "node_modules\n");
    fs.chmodSync(root, 0o500);
    messages.length = 0;
    await keepPrivate(Uri.file(root));
    fs.chmodSync(root, 0o700);
    assert.ok(text().includes("codelight.json"));
    assert.ok(warnings().some((entry) => entry.includes("in place")));
  });

  it("leaves a new file to the umask rather than forcing a mode", async () => {
    for (const [mask, expected] of [
      [0o077, 0o600],
      [0o022, 0o644]
    ]) {
      fs.rmSync(ignorePath, { force: true });
      const previous = process.umask(mask);
      try {
        await keepPrivate(Uri.file(root));
      } finally {
        process.umask(previous);
      }
      assert.equal(fs.statSync(ignorePath).mode & 0o777, expected, `umask ${mask.toString(8)}`);
    }
  });

  it("does not make a vscode folder it did not need", async () => {
    await keepPrivate(Uri.file(root));
    assert.ok(text().includes("codelight.json"));
    assert.equal(fs.existsSync(nodePath.join(root, ".vscode")), false);
  });

  it("warns once for each folder it saves in place", READ_ONLY_FOLDER, async () => {
    const second = fs.mkdtempSync(nodePath.join(os.tmpdir(), "codelight-other-"));
    const other = nodePath.join(second, ".gitignore");
    fs.writeFileSync(ignorePath, "node_modules\n");
    fs.writeFileSync(other, "node_modules\n");
    fs.chmodSync(root, 0o500);
    fs.chmodSync(second, 0o500);
    messages.length = 0;
    await keepPrivate(Uri.file(root));
    await keepPrivate(Uri.file(second));
    fs.chmodSync(root, 0o700);
    fs.chmodSync(second, 0o700);
    const said = warnings().filter((entry) => entry.includes("in place"));
    assert.equal(said.length, 2);
    assert.ok(said.some((entry) => entry.includes(ignorePath)));
    assert.ok(said.some((entry) => entry.includes(other)));
    fs.rmSync(second, { recursive: true, force: true });
  });

  it("writes a hard linked file in place", async () => {
    fs.writeFileSync(ignorePath, "node_modules\n");
    const twin = nodePath.join(root, "twin");
    fs.linkSync(ignorePath, twin);
    const before = fs.statSync(ignorePath).ino;
    await keepPrivate(Uri.file(root));
    assert.equal(fs.statSync(ignorePath).ino, before);
    assert.ok(fs.readFileSync(twin, "utf8").includes("codelight.json"));
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

  it("removes an entry from a mixed ending file", async () => {
    fs.writeFileSync(ignorePath, "node_modules\r\ndist\n.vscode/codelight.json\n");
    await stopKeepingPrivate(Uri.file(root));
    assert.equal(text().includes("codelight"), false);
    assert.ok(text().includes("node_modules"));
    assert.ok(text().includes("dist"));
  });

  it("keeps a heading the file already had above other rules", async () => {
    fs.writeFileSync(ignorePath, "# CodeLight notes, kept out of git\nsecrets.txt\n.vscode/codelight.json\n");
    await stopKeepingPrivate(Uri.file(root));
    assert.equal(text(), "# CodeLight notes, kept out of git\nsecrets.txt\n");
  });

  it("leaves the blank lines the file ends with alone", async () => {
    fs.writeFileSync(ignorePath, "node_modules\n.vscode/codelight.json\n\ndist\n\n");
    await stopKeepingPrivate(Uri.file(root));
    assert.equal(text(), "node_modules\n\ndist\n\n");
  });

  it("says so when the notes were never ignored", async () => {
    fs.writeFileSync(ignorePath, "node_modules\n");
    await stopKeepingPrivate(Uri.file(root));
    assert.equal(text(), "node_modules\n");
    assert.ok(infos().some((entry) => entry.includes("already go into git")));
  });

  it("says so when the folder has no gitignore at all", async () => {
    await stopKeepingPrivate(Uri.file(root));
    assert.equal(fs.existsSync(ignorePath), false);
    assert.ok(infos().some((entry) => entry.includes("already go into git")));
  });
});

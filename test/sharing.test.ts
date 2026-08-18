import * as assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { resetFake, Uri } from "./fakevscode";
import { describeSharing, Sharing, SharingState } from "../src/sharing";

const STORE = Uri.file("/repo/.vscode/codelight.json");

function fakeGit(answers: Record<string, number | undefined>): {
  run: (args: string[], cwd: string) => Promise<number | undefined>;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    run(args: string[], cwd: string) {
      void cwd;
      calls.push(args);
      const key = args[0];
      return Promise.resolve(key in answers ? answers[key] : 1);
    }
  };
}

async function stateOf(answers: Record<string, number | undefined>): Promise<Sharing> {
  const git = fakeGit(answers);
  return new SharingState(git.run).of(STORE as never);
}

beforeEach(() => {
  resetFake();
});

describe("what git says about the notes", () => {
  it("calls them ignored when git ignores them", async () => {
    assert.equal(await stateOf({ "rev-parse": 0, "check-ignore": 0 }), "ignored");
  });

  it("calls them tracked when git has them", async () => {
    assert.equal(
      await stateOf({ "rev-parse": 0, "check-ignore": 1, "ls-files": 0 }),
      "tracked"
    );
  });

  it("calls them untracked when git knows the folder but not the file", async () => {
    assert.equal(
      await stateOf({ "rev-parse": 0, "check-ignore": 1, "ls-files": 1 }),
      "untracked"
    );
  });

  it("says loose when the folder is not a repository", async () => {
    assert.equal(await stateOf({ "rev-parse": 128 }), "loose");
  });

  it("says nothing at all when git is missing", async () => {
    assert.equal(await stateOf({ "rev-parse": undefined }), "unknown");
    assert.equal(await stateOf({ "rev-parse": 0, "check-ignore": undefined }), "unknown");
    assert.equal(
      await stateOf({ "rev-parse": 0, "check-ignore": 1, "ls-files": undefined }),
      "unknown"
    );
  });

  it("leaves a file it cannot reach alone", async () => {
    const git = fakeGit({ "rev-parse": 0 });
    const remote = { ...Uri.file("/repo/.vscode/codelight.json"), scheme: "vscode-remote" };
    assert.equal(await new SharingState(git.run).of(remote as never), "unknown");
    assert.deepEqual(git.calls, []);
  });
});

describe("how often it asks", () => {
  it("asks once and remembers the answer", async () => {
    const git = fakeGit({ "rev-parse": 0, "check-ignore": 0 });
    const state = new SharingState(git.run);
    assert.equal(await state.of(STORE as never), "ignored");
    assert.equal(await state.of(STORE as never), "ignored");
    assert.equal(git.calls.length, 2);
    assert.equal(state.known(STORE as never), "ignored");
  });

  it("asks again once it is told to forget", async () => {
    const git = fakeGit({ "rev-parse": 0, "check-ignore": 0 });
    const state = new SharingState(git.run);
    await state.of(STORE as never);
    state.forget();
    assert.equal(state.known(STORE as never), undefined);
    await state.of(STORE as never);
    assert.equal(git.calls.length, 4);
  });

  it("runs one question at a time for the same file", async () => {
    const git = fakeGit({ "rev-parse": 0, "check-ignore": 0 });
    const state = new SharingState(git.run);
    const [first, second] = await Promise.all([
      state.of(STORE as never),
      state.of(STORE as never)
    ]);
    assert.equal(first, "ignored");
    assert.equal(second, "ignored");
    assert.equal(git.calls.length, 2);
  });
});

describe("how it words the answer", () => {
  it("says where the notes live only when it knows", () => {
    assert.ok(describeSharing("ignored").includes("stay on this machine"));
    assert.ok(describeSharing("tracked").includes("travel with the repository"));
    assert.ok(describeSharing("untracked").includes("not committed"));
    assert.equal(describeSharing("loose"), "");
    assert.equal(describeSharing("unknown"), "");
  });
});

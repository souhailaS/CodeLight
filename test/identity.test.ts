import * as assert from "node:assert/strict";
import * as os from "node:os";
import { beforeEach, describe, it } from "node:test";
import { authentication, messages, resetFake, Uri, workspace } from "./fakevscode";
import { IdentityProvider, localId, Remembers, sourceOf } from "../src/identity";

function provider(answers: Record<string, string | undefined>): IdentityProvider {
  return new IdentityProvider(async (args) => answers[args[1]]);
}

function memory(): Remembers {
  const held = new Map<string, unknown>();
  return {
    get<T>(key: string): T | undefined {
      return held.get(key) as T | undefined;
    },
    update(key: string, value: unknown) {
      held.set(key, value);
      return Promise.resolve();
    }
  };
}

beforeEach(() => {
  resetFake();
});

describe("who a note is signed by", () => {
  it("uses the github account when there is one", async () => {
    authentication.session = { account: { label: "ada", id: "42" }, accessToken: "t" };
    const who = await provider({}).require();
    assert.equal(who?.login, "ada");
    assert.equal(who?.id, "42");
    assert.equal(who?.verified, true);
  });

  it("falls back to the name git knows, without asking to sign in", async () => {
    const who = await provider({ "user.name": "Ada Lovelace", "user.email": "ada@b.c" }).require();
    assert.equal(who?.login, "Ada Lovelace");
    assert.equal(who?.id, localId("ada@b.c"));
    assert.equal(who?.verified, false);
    assert.deepEqual(messages, []);
  });

  it("uses the email when git has no name", async () => {
    const who = await provider({ "user.email": "ada@b.c" }).require();
    assert.equal(who?.login, "ada@b.c");
  });

  it("uses the machine account when git knows nothing", async () => {
    const who = await provider({}).require();
    assert.equal(who?.login, os.userInfo().username);
    assert.ok(who?.id.startsWith("local:"));
  });

  it("gives the same person the same id every time", async () => {
    const first = await provider({ "user.email": "ada@b.c" }).require();
    const second = await provider({ "user.name": "Someone Else", "user.email": "ada@b.c" }).require();
    assert.equal(first?.id, second?.id);
    assert.notEqual(first?.login, second?.login);
  });

  it("asks git once and remembers", async () => {
    const asked: string[][] = [];
    const who = new IdentityProvider(async (args) => {
      asked.push(args);
      return "ada";
    });
    await who.require();
    await who.require();
    assert.equal(asked.length, 2);
  });

  it("still owns the notes you wrote before you signed in", async () => {
    const who = new IdentityProvider(async (args) =>
      args[1] === "user.email" ? "ada@b.c" : "Ada Lovelace"
    );
    authentication.session = { account: { label: "ada", id: "42" }, accessToken: "t" };
    await who.prime();
    assert.equal(who.identity?.id, "42");
    assert.equal(who.owns({ login: "Ada Lovelace", id: localId("ada@b.c") }), true);
    assert.equal(who.owns({ login: "bob", id: "local:0123456789abcdef" }), false);
  });

  it("knows your own notes before you have written anything this window", async () => {
    const who = provider({ "user.email": "ada@b.c" });
    await who.prime();
    assert.equal(who.owns({ login: "ada@b.c", id: localId("ada@b.c") }), true);
  });

  it("keeps the local name when github has nothing to say", async () => {
    const who = provider({ "user.email": "ada@b.c" });
    await who.require();
    assert.equal(await who.refresh(), who.identity);
    assert.equal(who.identity?.id, localId("ada@b.c"));
  });

  it("tells two machines apart when git knows nothing about either", async () => {
    const first = new IdentityProvider(async () => undefined, memory());
    const second = new IdentityProvider(async () => undefined, memory());
    const one = await first.require();
    const other = await second.require();
    assert.equal(one.login, other.login);
    assert.notEqual(one.id, other.id);
  });

  it("keeps the same id on the same machine across windows", async () => {
    const held = memory();
    const one = await new IdentityProvider(async () => undefined, held).require();
    const other = await new IdentityProvider(async () => undefined, held).require();
    assert.equal(one.id, other.id);
  });

  it("reads the email whatever case git spells it in", async () => {
    const one = await provider({ "user.email": "Ada@B.C " }).require();
    const other = await provider({ "user.email": "ada@b.c" }).require();
    assert.equal(one.id, other.id);
  });

  it("asks the next folder when the first one has no identity", async () => {
    const asked: Array<string | undefined> = [];
    workspace.workspaceFolders = [
      { uri: Uri.file("/one"), name: "one", index: 0 },
      { uri: Uri.file("/two"), name: "two", index: 1 }
    ];
    const who = new IdentityProvider(async (args, cwd) => {
      asked.push(cwd);
      return cwd?.endsWith("two") === true && args[1] === "user.email" ? "ada@b.c" : undefined;
    });
    const found = await who.require();
    assert.equal(found.id, localId("ada@b.c"));
    assert.ok(asked.some((entry) => entry?.endsWith("one")), asked.join("|"));
  });

  it("asks git once when two callers arrive together", async () => {
    const asked: string[][] = [];
    const who = new IdentityProvider(async (args) => {
      asked.push(args);
      return "ada";
    });
    await Promise.all([who.require(), who.local(), who.require()]);
    assert.equal(asked.length, 2);
  });

  it("keeps the account you signed in with when a quiet check answers late", async () => {
    const who = provider({ "user.email": "ada@b.c" });
    authentication.session = undefined;
    authentication.delayMs = 20;
    const quiet = who.refresh();
    authentication.delayMs = 0;
    authentication.session = { account: { label: "ada", id: "42" }, accessToken: "t" };
    assert.equal((await who.signIn())?.id, "42");
    await quiet;
    assert.equal(who.identity?.id, "42");
    assert.equal(who.identity?.verified, true);
  });

  it("still gives you a name when git cannot be asked at all", async () => {
    const who = new IdentityProvider(async () => {
      throw new Error("git is not installed");
    });
    const first = await who.require();
    assert.ok(first.id.startsWith("local:"));
    assert.equal(first.source, "machine");
    assert.equal((await who.require()).id, first.id);
  });

  it("keeps one id across windows when the write of a fresh one fails", async () => {
    const broken = {
      get<T>(): T | undefined {
        return undefined;
      },
      update(): Thenable<void> {
        return Promise.reject(new Error("no room"));
      }
    };
    const one = await new IdentityProvider(async () => undefined, broken).require();
    const other = await new IdentityProvider(async () => undefined, broken).require();
    assert.equal(one.id, other.id);
  });

  it("does not wait forever on a write that never lands", async () => {
    const stuck = {
      get<T>(): T | undefined {
        return undefined;
      },
      update(): Thenable<void> {
        return new Promise<void>(() => undefined);
      }
    };
    const provider = new IdentityProvider(async () => undefined, stuck);
    const answer = await Promise.race([
      provider.require().then((who) => (who.id.startsWith("local:") ? "answered" : "odd")),
      new Promise((done) => setTimeout(() => done("hung"), 2500))
    ]);
    assert.equal(answer, "answered");
  });

  it("says nothing changed when nothing did", async () => {
    const who = provider({ "user.email": "ada@b.c" });
    const seen: Array<string | undefined> = [];
    const listener = who.onDidChange((identity) => seen.push(identity?.id));
    await who.prime();
    await who.prime();
    await who.refresh();
    listener.dispose();
    assert.deepEqual(seen, [localId("ada@b.c")]);
  });

  it("names the machine account for what it is", async () => {
    const who = await provider({}).require();
    assert.equal(who.source, "machine");
    assert.equal(sourceOf(who).includes("machine"), true);
    assert.equal(sourceOf({ ...who, source: "git" }).includes("git knows"), true);
  });

  it("keeps no avatar for a local name", async () => {
    const who = await provider({ "user.name": "ada" }).require();
    assert.equal(who?.avatarUrl, "");
  });
});

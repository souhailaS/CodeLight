import * as assert from "node:assert/strict";
import * as os from "node:os";
import { beforeEach, describe, it } from "node:test";
import { authentication, messages, resetFake } from "./fakevscode";
import { IdentityProvider, localId } from "../src/identity";

function provider(answers: Record<string, string | undefined>): IdentityProvider {
  return new IdentityProvider(async (args) => answers[args[1]]);
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

  it("keeps no avatar for a local name", async () => {
    const who = await provider({ "user.name": "ada" }).require();
    assert.equal(who?.avatarUrl, "");
  });
});

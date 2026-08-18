import * as assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { clipboard, resetFake } from "./fakevscode";
import { Annotation, Comment } from "../src/model";
import { rescue, withRescue } from "../src/rescue";
import { formatDate, inlineLabel, snippet, threadMarkdown } from "../src/thread";

function comment(id: string, body: string, login = "ada"): Comment {
  return {
    id,
    author: { login, id: "42" },
    body,
    createdAt: "2026-08-17T09:12:33.000Z",
    updatedAt: "2026-08-17T09:12:33.000Z"
  };
}

function annotation(text: string, comments: Comment[], id = "a1"): Annotation {
  return {
    id,
    file: "src/a.ts",
    range: { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 5 },
    anchor: { text, before: "", after: "" },
    color: "yellow",
    author: { login: "ada", id: "42" },
    createdAt: "2026-08-17T09:12:33.000Z",
    updatedAt: "2026-08-17T09:12:33.000Z",
    comments
  };
}

beforeEach(() => {
  resetFake();
});

describe("the snippet a row shows", () => {
  it("collapses the whitespace of the marked text", () => {
    assert.equal(snippet(annotation("const   one\n  = two", [])), "const one = two");
  });

  it("cuts a long snippet and says so", () => {
    const long = "x".repeat(80);
    const short = snippet(annotation(long, []));
    assert.equal(short.length, 51);
    assert.ok(short.endsWith("…"));
  });

  it("names an empty selection rather than showing nothing", () => {
    assert.equal(snippet(annotation("   ", [])), "empty selection");
  });
});

describe("the label at the end of the line", () => {
  it("shows the latest comment and who wrote it", () => {
    const label = inlineLabel(
      annotation("const", [comment("c1", "first"), comment("c2", "second", "bob")]),
      "preview"
    );
    assert.ok(label);
    assert.ok(label.includes("bob"));
    assert.ok(label.includes("second"));
    assert.ok(label.includes("(+1)"));
  });

  it("counts instead when the setting says so", () => {
    assert.equal(inlineLabel(annotation("const", [comment("c1", "first")]), "count"), " 1 comment");
    assert.equal(
      inlineLabel(annotation("const", [comment("c1", "a"), comment("c2", "b")]), "count"),
      " 2 comments"
    );
  });

  it("shows nothing when the setting is off or there is no comment", () => {
    assert.equal(inlineLabel(annotation("const", [comment("c1", "first")]), "off"), undefined);
    assert.equal(inlineLabel(annotation("const", []), "preview"), undefined);
  });

  it("keeps a very long comment out of the line", () => {
    const label = inlineLabel(annotation("const", [comment("c1", "y".repeat(200))]), "preview");
    assert.ok(label);
    assert.ok(label.length < 80);
    assert.ok(label.endsWith("…"));
  });
});

describe("the hover a highlight shows", () => {
  it("names the author when nobody has commented", () => {
    const markdown = threadMarkdown(annotation("const", []));
    assert.ok(markdown.value.includes("Highlighted by"));
    assert.ok(markdown.value.includes("@ada"));
    assert.ok(markdown.value.includes("Reply"));
    assert.equal(markdown.value.includes("Delete"), false);
  });

  it("offers edit and delete once there is a comment", () => {
    const markdown = threadMarkdown(annotation("const", [comment("c1", "first")]));
    assert.ok(markdown.value.includes("first"));
    assert.ok(markdown.value.includes("Reply"));
    assert.ok(markdown.value.includes("Edit"));
    assert.ok(markdown.value.includes("Delete"));
  });

  it("refuses to build a command link for an id it does not trust", () => {
    const markdown = threadMarkdown(annotation("const", [comment("c1", "first")], "a1 ' onclick"));
    assert.equal(markdown.value.includes("command:"), false);
    assert.ok(markdown.value.includes("first"));
  });

  it("leaves the date out when it cannot read one", () => {
    const entry = comment("c1", "first");
    entry.createdAt = "not a date";
    const markdown = threadMarkdown(annotation("const", [entry]));
    assert.equal(markdown.value.includes("@ada ·"), false);
    assert.ok(threadMarkdown(annotation("const", [comment("c1", "first")])).value.includes("@ada ·"));
    assert.equal(formatDate("not a date"), "");
  });
});

describe("rescuing what the user typed", () => {
  it("puts the text on the clipboard and says it did", async () => {
    assert.equal(await rescue("a note worth keeping"), true);
    assert.equal(clipboard.text, "a note worth keeping");
  });

  it("says it did not when the clipboard refuses", async () => {
    clipboard.failWrite = true;
    assert.equal(await rescue("a note worth keeping"), false);
    assert.equal(clipboard.text, "");
  });

  it("only adds the sentence when the text was kept", () => {
    assert.equal(withRescue("Gone.", false), "Gone.");
    assert.equal(withRescue("Gone.", true), "Gone. Your comment was copied to the clipboard.");
  });

  it("speaks of several comments when several were lost", () => {
    assert.equal(withRescue("Gone.", true, true), "Gone. They were copied to the clipboard together.");
    assert.equal(withRescue("Gone.", false, true), "Gone.");
  });
});

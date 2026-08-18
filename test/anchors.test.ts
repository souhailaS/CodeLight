import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAnchor, findAnchor, MAX_ANCHOR_TEXT } from "../src/anchors";

const doc = "alpha\nconst count = 1;\nbeta\nconst other = 2;\ngamma\n";

function anchorOf(text: string, needle: string) {
  const start = text.indexOf(needle);
  return buildAnchor(text, start, start + needle.length);
}

describe("buildAnchor", () => {
  it("keeps the selected text with the lines around it", () => {
    const anchor = anchorOf(doc, "count = 1");
    assert.equal(anchor.text, "count = 1");
    assert.equal(anchor.before, "alpha\nconst ");
    assert.equal(anchor.after, ";\nbeta\nconst other = 2;\ngamma\n");
  });

  it("takes at most sixty characters of context on each side", () => {
    const text = `${"a".repeat(200)}needle${"b".repeat(200)}`;
    const anchor = anchorOf(text, "needle");
    assert.equal(anchor.before, "a".repeat(60));
    assert.equal(anchor.after, "b".repeat(60));
  });

  it("takes what it can when the selection sits at the edges", () => {
    const anchor = buildAnchor("abc", 0, 3);
    assert.deepEqual(anchor, { text: "abc", before: "", after: "" });
  });

  it("truncates the text at four hundred characters", () => {
    const long = "x".repeat(500);
    const text = `head ${long} tail`;
    const anchor = buildAnchor(text, 5, 5 + long.length);
    assert.equal(MAX_ANCHOR_TEXT, 400);
    assert.equal(anchor.text.length, MAX_ANCHOR_TEXT);
    assert.equal(anchor.before, "head ");
    assert.equal(anchor.after, "x".repeat(60));
    assert.ok(text.includes(`${anchor.before}${anchor.text}${anchor.after}`));
  });

  it("builds an anchor a search can find again", () => {
    const anchor = anchorOf(doc, "count");
    const found = findAnchor(doc, anchor);
    assert.ok(found);
    assert.equal(found.start, doc.indexOf("count"));
    assert.equal(doc.slice(found.start, found.end), "count");
  });
});

describe("findAnchor", () => {
  it("finds the text after the document moves", () => {
    const anchor = anchorOf(doc, "count");
    const moved = `header\n${doc}`;
    const found = findAnchor(moved, anchor);
    assert.ok(found);
    assert.equal(found.start, moved.indexOf("count"));
  });

  it("falls back to the text and the context before it", () => {
    const anchor = anchorOf(doc, "count");
    const trimmed = doc.slice(0, doc.indexOf(";\nbeta"));
    const found = findAnchor(trimmed, anchor);
    assert.ok(found);
    assert.equal(trimmed.slice(found.start, found.end), "count");
  });

  it("falls back to the text and the context after it", () => {
    const anchor = anchorOf(doc, "count");
    const trimmed = doc.slice(doc.indexOf("const count"));
    const found = findAnchor(trimmed, anchor);
    assert.ok(found);
    assert.equal(trimmed.slice(found.start, found.end), "count");
  });

  it("refuses a match that is not unique", () => {
    const twins = "if (x) {\n  return null;\n}\nif (y) {\n  return null;\n}\n";
    assert.equal(findAnchor(twins, { text: "return null;", before: "", after: "" }), undefined);
    assert.equal(findAnchor(doc, { text: "const", before: "", after: "" }), undefined);
  });

  it("uses the context to tell two identical selections apart", () => {
    const twins = "if (x) {\n  return null;\n}\nif (y) {\n  return null;\n}\n";
    const second = twins.lastIndexOf("return null;");
    const anchor = buildAnchor(twins, second, second + "return null;".length);
    const found = findAnchor(twins, anchor);
    assert.ok(found);
    assert.equal(found.start, second);
  });

  it("gives up when the text is gone", () => {
    assert.equal(findAnchor(doc, { text: "missing", before: "", after: "" }), undefined);
    assert.equal(findAnchor("", { text: "count", before: "", after: "" }), undefined);
  });

  it("gives up when the anchor has no text", () => {
    assert.equal(findAnchor(doc, { text: "", before: "alpha", after: "beta" }), undefined);
  });

  it("finds a unique selection with no context at all", () => {
    const found = findAnchor(doc, { text: "gamma", before: "", after: "" });
    assert.ok(found);
    assert.equal(found.start, doc.indexOf("gamma"));
  });
});

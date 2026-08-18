import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { Annotation, isSafeRelativePath, parseStore, serializeStore, STORE_VERSION } from "../src/model";

const author = { login: "ada", id: "42" };

function wire(entries: unknown[], version: number = STORE_VERSION): string {
  return JSON.stringify({ version, annotations: entries });
}

function annotation(id: string, file: string): Annotation {
  return {
    id,
    file,
    range: { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 5 },
    anchor: { text: "const", before: "", after: "" },
    color: "yellow",
    author,
    createdAt: "2026-08-17T09:12:33.000Z",
    updatedAt: "2026-08-17T09:12:33.000Z",
    comments: []
  };
}

const messy = wire([
  {
    id: "b",
    file: "z.ts",
    range: { startLine: 5, startCharacter: 40, endLine: 5, endCharacter: 2 },
    anchor: { text: "x" },
    color: "pink",
    author,
    createdAt: "t",
    comments: [
      { id: "c", author, body: "hi", createdAt: "t" },
      { id: "c", author, body: "dup", createdAt: "t" }
    ]
  },
  {
    id: "a",
    file: "src/a.ts",
    range: { startLine: 2, startCharacter: 1, endLine: 2, endCharacter: 9 },
    anchor: {},
    color: "yellow",
    author,
    createdAt: "t",
    comments: []
  },
  { id: "bc", file: "c.ts", author, comments: [{ body: "no id" }] },
  { id: "a", file: "dup.ts", author },
  { id: "no-author", file: "x.ts" },
  { id: "escape", file: "../../../.ssh/config", author },
  { id: "abs", file: "/etc/passwd", author },
  { id: "win", file: "C:\\secrets", author },
  "junk"
]);

describe("parseStore", () => {
  it("keeps the readable entries and counts the rest", () => {
    const parsed = parseStore(messy);
    assert.equal(parsed.annotations.length, 3);
    assert.equal(parsed.dropped, 8);
    assert.equal(parsed.rejected.length, 6);
  });

  it("orders the end of a range after its start", () => {
    const parsed = parseStore(messy);
    assert.deepEqual(parsed.annotations[0].range, {
      startLine: 5,
      startCharacter: 40,
      endLine: 5,
      endCharacter: 40
    });
  });

  it("fills in the defaults a partial entry leaves out", () => {
    const parsed = parseStore(wire([{ id: "a", file: "a.ts", author, createdAt: "t" }]));
    const entry = parsed.annotations[0];
    assert.deepEqual(entry.range, { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0 });
    assert.deepEqual(entry.anchor, { text: "", before: "", after: "" });
    assert.equal(entry.color, "yellow");
    assert.equal(entry.updatedAt, "t");
  });

  it("clamps a line number that is negative or fractional", () => {
    const parsed = parseStore(
      wire([
        {
          id: "a",
          file: "a.ts",
          author,
          range: { startLine: -4, startCharacter: 2.7, endLine: 9.9, endCharacter: 1 }
        }
      ])
    );
    assert.deepEqual(parsed.annotations[0].range, {
      startLine: 0,
      startCharacter: 2,
      endLine: 9,
      endCharacter: 1
    });
  });

  it("drops a comment without an id or an author", () => {
    const parsed = parseStore(
      wire([
        {
          id: "a",
          file: "a.ts",
          author,
          comments: [
            { id: "one", author, body: "kept", createdAt: "t" },
            { id: "", author, body: "no id" },
            { id: "two", body: "no author" },
            { id: "one", author, body: "duplicate" }
          ]
        }
      ])
    );
    assert.deepEqual(
      parsed.annotations[0].comments.map((comment) => comment.body),
      ["kept"]
    );
    assert.equal(parsed.annotations[0].rejectedComments?.length, 3);
    assert.equal(parsed.dropped, 3);
  });

  it("falls back to the creation time when a comment has no update time", () => {
    const parsed = parseStore(
      wire([{ id: "a", file: "a.ts", author, comments: [{ id: "c", author, body: "hi", createdAt: "t" }] }])
    );
    assert.equal(parsed.annotations[0].comments[0].updatedAt, "t");
  });

  it("drops a second entry that reuses an id", () => {
    const parsed = parseStore(wire([annotation("a", "one.ts"), annotation("a", "two.ts")]));
    assert.deepEqual(
      parsed.annotations.map((entry) => entry.file),
      ["one.ts"]
    );
    assert.equal(parsed.dropped, 1);
    assert.equal(parsed.rejected.length, 1);
  });

  it("keeps the orphan flag only when it is true", () => {
    const parsed = parseStore(
      wire([
        { id: "o", file: "a.ts", author, orphaned: true, comments: [] },
        { id: "n", file: "a.ts", author, orphaned: "yes", comments: [] },
        { id: "m", file: "a.ts", author, comments: [] }
      ])
    );
    assert.equal(parsed.annotations[0].orphaned, true);
    assert.equal(parsed.annotations[1].orphaned, undefined);
    assert.equal(parsed.annotations[2].orphaned, undefined);
  });

  it("refuses a file that is not valid JSON", () => {
    assert.throws(() => parseStore("{oops"), /not valid JSON/);
  });

  it("refuses a file that is not an object", () => {
    assert.throws(() => parseStore("[]"), /must contain an object/);
    assert.throws(() => parseStore("null"), /must contain an object/);
  });

  it("refuses a format version from a newer build", () => {
    assert.throws(() => parseStore(wire([], STORE_VERSION + 1)), /format version 2/);
  });

  it("refuses a version that is not a number", () => {
    assert.throws(() => parseStore('{"version":"1","annotations":[]}'), /not a number/);
    assert.throws(() => parseStore('{"version":null,"annotations":[]}'), /not a number/);
  });

  it("accepts a file with no version and a file from an older build", () => {
    assert.equal(parseStore('{"annotations":[]}').annotations.length, 0);
    assert.equal(parseStore(wire([], 0)).annotations.length, 0);
  });

  it("treats a missing or malformed annotation list as empty", () => {
    assert.equal(parseStore('{"version":1,"annotations":"nope"}').annotations.length, 0);
    assert.equal(parseStore('{"version":1}').annotations.length, 0);
  });

  it("leaves an id that looks like a command link alone", () => {
    const parsed = parseStore(
      wire([
        { id: "evil) [x](command:workbench.action.quit", file: "a.ts", author, comments: [] },
        { id: "ok", file: "a.ts", author, comments: [{ id: "c) [x](command:x", author, body: "hi" }] }
      ])
    );
    assert.equal(parsed.annotations.length, 2);
    assert.equal(parsed.dropped, 0);
  });
});

describe("isSafeRelativePath", () => {
  it("accepts a plain relative path", () => {
    assert.ok(isSafeRelativePath("a.ts"));
    assert.ok(isSafeRelativePath("src/nested/a.ts"));
  });

  it("rejects anything that could escape the workspace", () => {
    for (const candidate of [
      "",
      "/a",
      "../x",
      "a/../b",
      "./a",
      "a/./b",
      "a//b",
      "a/",
      "C:/secrets",
      "c:\\secrets",
      "a\\b"
    ]) {
      assert.equal(isSafeRelativePath(candidate), false, candidate);
    }
  });
});

describe("serializeStore", () => {
  it("writes the current version and ends with a newline", () => {
    const text = serializeStore([annotation("a", "a.ts")]);
    assert.equal(JSON.parse(text).version, STORE_VERSION);
    assert.ok(text.endsWith("}\n"));
  });

  it("sorts by file, then by position, then by id", () => {
    function at(id: string, startLine: number, startCharacter: number): Annotation {
      const entry = annotation(id, "src/a.ts");
      entry.range = { startLine, startCharacter, endLine: startLine, endCharacter: startCharacter };
      return entry;
    }
    const written = JSON.parse(
      serializeStore([
        annotation("b", "z.ts"),
        at("z", 1, 0),
        at("k", 1, 9),
        at("a", 1, 0),
        at("m", 0, 0),
        annotation("c", "a.ts")
      ])
    ) as { annotations: Array<{ id: string }> };
    assert.deepEqual(
      written.annotations.map((entry) => entry.id),
      ["c", "m", "a", "z", "k", "b"]
    );
  });

  it("keeps the rejected entries in the file", () => {
    const parsed = parseStore(messy);
    const text = serializeStore(parsed.annotations, parsed.rejected);
    const written = JSON.parse(text) as { annotations: unknown[] };
    assert.equal(written.annotations.length, 9);
    assert.ok(!text.includes("rejectedComments"));
  });

  it("puts a rejected comment back beside the readable ones", () => {
    const parsed = parseStore(messy);
    const written = JSON.parse(serializeStore(parsed.annotations, parsed.rejected)) as {
      annotations: Array<{ id: string; comments?: unknown[] }>;
    };
    const kept = written.annotations.find((entry) => entry.id === "b");
    assert.equal(kept?.comments?.length, 2);
  });

  it("omits the orphan flag when it is not set", () => {
    const parsed = parseStore(
      wire([
        { id: "o", file: "a.ts", author, orphaned: true, comments: [] },
        { id: "n", file: "a.ts", author, comments: [] }
      ])
    );
    const written = JSON.parse(serializeStore(parsed.annotations)) as {
      annotations: Array<Record<string, unknown>>;
    };
    const byId = new Map(written.annotations.map((entry) => [entry.id as string, entry]));
    assert.equal(byId.get("o")?.orphaned, true);
    assert.ok(!Object.prototype.hasOwnProperty.call(byId.get("n"), "orphaned"));
  });
});

describe("round trip", () => {
  it("reaches a fixed point after one pass", () => {
    const parsed = parseStore(messy);
    const text = serializeStore(parsed.annotations, parsed.rejected);
    const again = parseStore(text);
    assert.equal(again.annotations.length, 3);
    assert.equal(again.dropped, 8);
    assert.equal(again.rejected.length, 6);
    assert.equal(serializeStore(again.annotations, again.rejected), text);
  });

  it("survives a gzip round trip and a byte order mark", () => {
    const parsed = parseStore(messy);
    const text = serializeStore(parsed.annotations, parsed.rejected);
    const unpacked = gunzipSync(gzipSync(Buffer.from(`\uFEFF${text}`, "utf8"))).toString("utf8");
    assert.throws(() => parseStore(unpacked), /not valid JSON/);
    const stripped = unpacked.replace(/^\uFEFF/, "");
    assert.equal(stripped, text);
    assert.deepEqual(parseStore(stripped), parseStore(text));
  });

  it("survives a store with many annotations", () => {
    const many: Annotation[] = [];
    for (let index = 0; index < 200; index += 1) {
      const entry = annotation(`ann-${index}`, `src/module${index % 20}/file${index % 7}.ts`);
      entry.range = { startLine: index * 3, startCharacter: 4, endLine: index * 3 + 1, endCharacter: 28 };
      entry.comments = [
        { id: `c-${index}`, author, body: "a body worth a few bytes", createdAt: "t", updatedAt: "t" }
      ];
      many.push(entry);
    }
    const text = serializeStore(many);
    const restored = parseStore(gunzipSync(gzipSync(Buffer.from(text, "utf8"))).toString("utf8"));
    assert.equal(restored.annotations.length, 200);
    assert.equal(restored.dropped, 0);
    assert.equal(serializeStore(restored.annotations, restored.rejected), text);
  });
});

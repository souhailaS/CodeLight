import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { describe, it } from "node:test";
import { readPalette } from "../src/palette";
import { setConfiguration } from "./fakevscode";

interface Manifest {
  contributes: {
    commands: Array<{ command: string; title: string; category?: string }>;
    keybindings: Array<{ command: string; key: string; mac?: string; when?: string }>;
    menus: Record<string, Array<{ command: string; when?: string; group?: string }>>;
    views: Record<string, Array<{ id: string; name: string; type?: string }>>;
    configuration: { properties: Record<string, { scope?: string }> };
  };
}

const manifest = JSON.parse(
  fs.readFileSync(nodePath.join(__dirname, "..", "..", "package.json"), "utf8")
) as Manifest;

const RESERVED = [
  "ctrl+k ctrl+a",
  "ctrl+k ctrl+b",
  "ctrl+k ctrl+c",
  "ctrl+k ctrl+d",
  "ctrl+k ctrl+e",
  "ctrl+k ctrl+f",
  "ctrl+k ctrl+h",
  "ctrl+k ctrl+i",
  "ctrl+k ctrl+j",
  "ctrl+k ctrl+k",
  "ctrl+k ctrl+l",
  "ctrl+k ctrl+m",
  "ctrl+k ctrl+n",
  "ctrl+k ctrl+o",
  "ctrl+k ctrl+p",
  "ctrl+k ctrl+q",
  "ctrl+k ctrl+r",
  "ctrl+k ctrl+s",
  "ctrl+k ctrl+t",
  "ctrl+k ctrl+u",
  "ctrl+k ctrl+w",
  "ctrl+k ctrl+x"
];

describe("the manifest", () => {
  it("keeps off the chords VS Code reserves", () => {
    for (const binding of manifest.contributes.keybindings) {
      assert.equal(
        RESERVED.includes(binding.key.toLowerCase()),
        false,
        `${binding.command} takes over ${binding.key}`
      );
    }
  });

  it("keeps to keys that every keyboard layout can reach", () => {
    for (const binding of manifest.contributes.keybindings) {
      const last = binding.key.split(" ").pop() ?? "";
      assert.match(
        last,
        /^ctrl\+[a-z]$/,
        `${binding.command} ends on ${last}, which not every layout types the same way`
      );
    }
  });

  it("binds every key only once", () => {
    const keys = manifest.contributes.keybindings.flatMap((binding) =>
      [binding.key, binding.mac].filter((entry): entry is string => entry !== undefined)
    );
    assert.equal(new Set(keys).size, keys.length);
  });

  it("offers a menu for every context value the tree sets", () => {
    const values = ["annotation", "orphan", "file", "comment"];
    const menus = manifest.contributes.menus["view/item/context"];
    for (const value of values) {
      assert.ok(
        menus.some((entry) => new RegExp(`\\b${value}\\b`).test(entry.when ?? "")),
        `nothing reaches codelight.${value}`
      );
    }
  });

  it("points every menu entry at a command it declares", () => {
    const known = new Set(manifest.contributes.commands.map((entry) => entry.command));
    for (const [where, entries] of Object.entries(manifest.contributes.menus)) {
      for (const entry of entries) {
        if (!entry.command.startsWith("codelight.")) {
          continue;
        }
        assert.ok(known.has(entry.command), `${where} points at ${entry.command}`);
      }
    }
  });

  it("scopes every setting to the folder it belongs to", () => {
    for (const [name, spec] of Object.entries(manifest.contributes.configuration.properties)) {
      assert.equal(spec.scope, "resource", `${name} is not folder scoped`);
    }
  });
});

describe("a palette from the annotation file", () => {
  it("strips the codicon markup a label could smuggle", () => {
    setConfiguration("codelight.palette", [
      { id: "one", label: "$(trash) Delete everything", hex: "#112233" }
    ]);
    assert.deepEqual(
      readPalette().map((color) => color.label),
      ["(trash) Delete everything"]
    );
  });

  it("falls back to the id when the label is only markup", () => {
    setConfiguration("codelight.palette", [{ id: "two", label: "   ", hex: "#112233" }]);
    assert.deepEqual(
      readPalette().map((color) => color.label),
      ["two"]
    );
  });
});

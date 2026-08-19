import * as vscode from "vscode";
import { buildAnchor, findAnchor } from "./anchors";
import { HighlightRenderer } from "./decorations";
import { newId, timestamp } from "./ids";
import { IdentityProvider } from "./identity";
import { LiveRanges } from "./live";
import { Anchor, Annotation } from "./model";
import { DEFAULT_PALETTE, PaletteColor } from "./palette";
import { Swatches } from "./swatches";
import { AnnotationStore } from "./store";
import { Visibility } from "./visibility";
import { snippet } from "./thread";

function themeSwatch(color: PaletteColor): vscode.ThemeIcon {
  const known = DEFAULT_PALETTE.some(
    (entry) => entry.id === color.id && entry.hex.toLowerCase() === color.hex.toLowerCase()
  );
  return known
    ? new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor(`codelight.${color.id}`))
    : new vscode.ThemeIcon("circle-filled");
}

let swatches: Swatches | undefined;

export function useSwatches(store: Swatches): void {
  swatches = store;
}

export async function pickColor(
  palette: readonly PaletteColor[],
  title: string
): Promise<PaletteColor | undefined> {
  const items = await Promise.all(
    palette.map(async (color) => ({
      label: color.label,
      description: color.hex,
      iconPath: (swatches ? await swatches.iconFor(color) : undefined) ?? themeSwatch(color),
      color
    }))
  );
  const picked = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: "Pick a highlight color"
  });
  return picked?.color;
}

export class HighlightCommands {
  constructor(
    private readonly store: AnnotationStore,
    private readonly identity: IdentityProvider,
    private readonly renderer: HighlightRenderer,
    private readonly live: LiveRanges,
    private readonly visibility: Visibility
  ) {}

  async add(
    preset?: PaletteColor,
    only?: readonly vscode.Range[],
    target?: vscode.TextEditor
  ): Promise<Annotation[]> {
    const editor = target ?? vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage("Open a file to highlight.");
      return [];
    }
    const relative = this.store.relative(editor.document.uri);
    const root = this.store.rootFor(editor.document.uri);
    if (!relative || !root) {
      void vscode.window.showWarningMessage(
        this.store.isReady
          ? "CodeLight can only annotate files inside a folder of this workspace."
          : "CodeLight needs an open folder."
      );
      return [];
    }
    const ranges: vscode.Range[] = [];
    const sources = only ?? editor.selections;
    const taken = only === undefined ? [] : this.markedRanges(editor);
    for (const selection of sources) {
      const range = selection.isEmpty
        ? editor.document.lineAt(selection.start.line).range
        : new vscode.Range(selection.start, selection.end);
      if (range.isEmpty || ranges.some((existing) => existing.isEqual(range))) {
        continue;
      }
      if (taken.some((existing) => existing.isEqual(range))) {
        continue;
      }
      ranges.push(range);
    }
    if (ranges.length === 0) {
      if (only === undefined) {
        void vscode.window.showWarningMessage(
          editor.selections.every((selection) => selection.isEmpty)
            ? "This line is empty. Select some text to highlight."
            : "Select some text to highlight."
        );
      }
      return [];
    }
    const text = editor.document.getText();
    const offsets = ranges.map((range) => ({
      start: editor.document.offsetAt(range.start),
      end: editor.document.offsetAt(range.end)
    }));
    const anchors = offsets.map((offset) => buildAnchor(text, offset.start, offset.end));
    const version = editor.document.version;
    const author = await this.identity.require();
    if (!author) {
      return [];
    }
    const color =
      preset ?? (await pickColor(this.renderer.colorsFor(editor.document.uri), "CodeLight"));
    if (!color) {
      return [];
    }
    let placed = ranges;
    let placedAnchors = anchors;
    if (editor.document.version !== version) {
      const current = editor.document.getText();
      const relocated: vscode.Range[] = [];
      const rebuilt: Anchor[] = [];
      for (const [index, anchor] of anchors.entries()) {
        const found = findAnchor(current, anchor);
        if (!found) {
          void vscode.window.showWarningMessage(
            "The file changed and the selection could not be found again."
          );
          return [];
        }
        const wanted = offsets[index].end - offsets[index].start;
        const end = Math.min(current.length, found.start + Math.max(found.end - found.start, wanted));
        relocated.push(
          new vscode.Range(editor.document.positionAt(found.start), editor.document.positionAt(end))
        );
        rebuilt.push(buildAnchor(current, found.start, end));
      }
      placed = relocated;
      placedAnchors = rebuilt;
    }
    if (only === undefined) {
      this.visibility.show();
    }
    const now = timestamp();
    const created = placed.map((range, index) => ({
      id: newId(),
      file: relative,
      range: {
        startLine: range.start.line,
        startCharacter: range.start.character,
        endLine: range.end.line,
        endCharacter: range.end.character
      },
      anchor: placedAnchors[index],
      color: color.id,
      author: { login: author.login, id: author.id },
      createdAt: now,
      updatedAt: now,
      comments: []
    })) as Annotation[];
    for (const annotation of created) {
      annotation.root = root.toString();
    }
    const saved = await this.store.transaction(root, (annotations) => {
      for (const annotation of created) {
        annotations.set(annotation.id, annotation);
      }
      return true;
    });
    if (!saved) {
      void vscode.window.showWarningMessage("CodeLight could not save the highlight.");
      return [];
    }
    return created;
  }

  atCursor(): Annotation[] {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return [];
    }
    const position = editor.selection.active;
    const placed = this.live.placedIn(editor.document);
    const spans = placed.spans;
    return this.store.forFile(editor.document.uri).filter((annotation) => {
      if (placed.detached.has(annotation.id)) {
        return false;
      }
      if (annotation.orphaned === true) {
        return annotation.range.startLine === position.line;
      }
      const range = this.live.rangeFor(editor.document, annotation, spans);
      return range.isEmpty ? range.start.line === position.line : range.contains(position);
    });
  }

  markedRanges(editor: vscode.TextEditor): vscode.Range[] {
    const placed = this.live.placedIn(editor.document);
    const spans = placed.spans;
    const taken: vscode.Range[] = [];
    for (const annotation of this.store.forFile(editor.document.uri)) {
      if (annotation.orphaned === true || placed.detached.has(annotation.id)) {
        continue;
      }
      taken.push(this.live.rangeFor(editor.document, annotation, spans));
    }
    return taken;
  }

  isCollapsed(annotation: Annotation): boolean {
    const editor = vscode.window.activeTextEditor;
    const relative = editor ? this.store.relative(editor.document.uri) : undefined;
    if (!editor || relative !== annotation.file) {
      return annotation.orphaned === true;
    }
    return this.live.rangeFor(editor.document, annotation).isEmpty;
  }

  atCursorLive(): Annotation[] {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return [];
    }
    const spans = this.live.spansFor(editor.document);
    return this.atCursor().filter((annotation) => {
      if (annotation.orphaned === true) {
        return false;
      }
      return !this.live.rangeFor(editor.document, annotation, spans).isEmpty;
    });
  }

  enclosing(selection: vscode.Selection): Annotation[] {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return [];
    }
    const placed = this.live.placedIn(editor.document);
    const spans = placed.spans;
    return this.store.forFile(editor.document.uri).filter((annotation) => {
      if (annotation.orphaned === true || placed.detached.has(annotation.id)) {
        return false;
      }
      const range = this.live.rangeFor(editor.document, annotation, spans);
      return !range.isEmpty && range.contains(selection);
    });
  }

  async pickAtCursor(title: string, provided?: Annotation[]): Promise<Annotation | undefined> {
    const candidates = provided ?? this.atCursor();
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage("No CodeLight highlight at the cursor.");
      return undefined;
    }
    const editor = vscode.window.activeTextEditor;
    const spans = editor ? this.live.spansFor(editor.document) : undefined;
    const isOrphan = (annotation: Annotation): boolean =>
      annotation.orphaned === true ||
      (editor !== undefined && this.live.rangeFor(editor.document, annotation, spans).isEmpty);
    if (candidates.length === 1 && !isOrphan(candidates[0])) {
      return candidates[0];
    }
    const picked = await vscode.window.showQuickPick(
      candidates.map((annotation) => {
        const orphan = isOrphan(annotation);
        const thread =
          annotation.comments.length === 0
            ? ""
            : `, ${annotation.comments.length} comment${annotation.comments.length === 1 ? "" : "s"}`;
        return {
          label: orphan ? `${snippet(annotation)} (text deleted)` : snippet(annotation),
          description: `${annotation.color} by ${annotation.author.login}${thread}`,
          annotation
        };
      }),
      { title }
    );
    return picked?.annotation;
  }

  async remove(): Promise<void> {
    const annotation = await this.pickAtCursor("Remove highlight");
    if (!annotation) {
      return;
    }
    const fresh = this.store.byId(annotation.id) ?? annotation;
    const count = fresh.comments.length;
    if (count > 0) {
      const confirmed = await vscode.window.showWarningMessage(
        `Remove this highlight and its ${count} comment${count === 1 ? "" : "s"}?`,
        { modal: true },
        "Remove"
      );
      if (confirmed !== "Remove") {
        return;
      }
    }
    let drifted = false;
    let missing = false;
    const removed = await this.store.transaction(annotation.root, (annotations) => {
      const current = annotations.get(annotation.id);
      if (!current) {
        missing = true;
        return false;
      }
      if (current.comments.length !== count) {
        drifted = true;
        return false;
      }
      annotations.delete(annotation.id);
      return true;
    });
    if (missing) {
      await this.store.refresh();
      void vscode.window.showWarningMessage("That highlight is no longer in the annotation file.");
      return;
    }
    if (drifted) {
      await this.store.refresh();
      void vscode.window.showWarningMessage(
        "The comments on that highlight just changed. Run Remove Highlight again to confirm."
      );
      return;
    }
    if (!removed) {
      void vscode.window.showWarningMessage("CodeLight could not update the annotation file.");
    }
  }

  async removeOrphaned(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const root = editor ? this.store.rootFor(editor.document.uri) : undefined;
    if (!editor || !root) {
      void vscode.window.showWarningMessage("Open a file inside a folder of this workspace to clean up its highlights.");
      return;
    }
    const orphans = this.store
      .forFile(editor.document.uri)
      .filter((annotation) => annotation.orphaned === true);
    if (orphans.length === 0) {
      void vscode.window.showInformationMessage("No orphaned highlights in this file.");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      orphans.map((annotation) => ({
        label: snippet(annotation),
        description:
          annotation.comments.length === 0
            ? `by ${annotation.author.login}`
            : `by ${annotation.author.login}, ${annotation.comments.length} comment${annotation.comments.length === 1 ? "" : "s"} will be deleted`,
        picked: annotation.comments.length === 0,
        annotation
      })),
      { title: "Remove orphaned highlights", canPickMany: true }
    );
    if (!picked || picked.length === 0) {
      return;
    }
    const threaded = picked.filter((item) => item.annotation.comments.length > 0);
    if (threaded.length > 0) {
      const total = threaded.reduce((sum, item) => sum + item.annotation.comments.length, 0);
      const confirmed = await vscode.window.showWarningMessage(
        `Delete ${threaded.length} highlight${threaded.length === 1 ? "" : "s"} carrying ${total} comment${total === 1 ? "" : "s"}?`,
        { modal: true },
        "Delete"
      );
      if (confirmed !== "Delete") {
        return;
      }
    }
    const expected = new Map(
      picked.map((item) => [item.annotation.id, item.annotation.comments.length])
    );
    let drifted = false;
    const saved = await this.store.transaction(root, (annotations) => {
      let changed = false;
      for (const [id, count] of expected) {
        const current = annotations.get(id);
        if (!current) {
          continue;
        }
        if (current.comments.length !== count) {
          drifted = true;
          return false;
        }
        annotations.delete(id);
        changed = true;
      }
      return changed;
    });
    if (drifted) {
      await this.store.refresh();
      void vscode.window.showWarningMessage(
        "Those highlights just changed. Run Remove Orphaned Highlights again to confirm."
      );
      return;
    }
    const remaining = [...expected.keys()].some((id) => this.store.byId(id) !== undefined);
    if (!saved && remaining) {
      void vscode.window.showWarningMessage("CodeLight could not update the annotation file.");
    }
  }

  async recolor(): Promise<void> {
    const annotation = await this.pickAtCursor("Change highlight color");
    if (!annotation) {
      return;
    }
    if (annotation.orphaned === true) {
      void vscode.window.showWarningMessage(
        "That highlight lost its text. Remove it instead of recoloring it."
      );
      return;
    }
    const color = await pickColor(
      this.renderer.colorsFor(this.store.uriFor(annotation)),
      "Change highlight color"
    );
    if (!color) {
      return;
    }
    this.visibility.show();
    const saved = await this.store.update(annotation.id, (current) => ({
      ...current,
      color: color.id,
      updatedAt: timestamp()
    }));
    if (!saved) {
      void vscode.window.showWarningMessage("That highlight is no longer in the annotation file.");
    }
  }
}

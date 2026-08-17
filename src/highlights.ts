import * as vscode from "vscode";
import { buildAnchor, findAnchor } from "./anchors";
import { HighlightRenderer } from "./decorations";
import { newId, timestamp } from "./ids";
import { IdentityProvider } from "./identity";
import { LiveRanges } from "./live";
import { Anchor, Annotation } from "./model";
import { DEFAULT_PALETTE, PaletteColor } from "./palette";
import { toRelativePath } from "./paths";
import { AnnotationStore } from "./store";
import { snippet } from "./thread";

function colorIcon(color: PaletteColor): vscode.ThemeIcon {
  const isDefault = DEFAULT_PALETTE.some(
    (entry) => entry.id === color.id && entry.hex.toLowerCase() === color.hex.toLowerCase()
  );
  return isDefault
    ? new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor(`codelight.${color.id}`))
    : new vscode.ThemeIcon("circle-filled");
}

export async function pickColor(
  palette: readonly PaletteColor[],
  title: string
): Promise<PaletteColor | undefined> {
  const items = palette.map((color) => ({
    label: color.label,
    description: color.hex,
    iconPath: colorIcon(color),
    color
  }));
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
    private readonly live: LiveRanges
  ) {}

  async add(): Promise<Annotation[]> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage("Open a file to highlight.");
      return [];
    }
    const root = this.store.rootUri;
    const relative = root ? toRelativePath(root, editor.document.uri) : undefined;
    if (!relative) {
      const folder = root ? root.path.split("/").pop() : undefined;
      void vscode.window.showWarningMessage(
        folder
          ? `CodeLight is tracking the folder ${folder} and cannot annotate files outside it.`
          : "CodeLight needs an open folder."
      );
      return [];
    }
    const ranges: vscode.Range[] = [];
    for (const selection of editor.selections) {
      const range = selection.isEmpty
        ? editor.document.lineAt(selection.active.line).range
        : new vscode.Range(selection.start, selection.end);
      if (range.isEmpty || ranges.some((existing) => existing.isEqual(range))) {
        continue;
      }
      ranges.push(range);
    }
    if (ranges.length === 0) {
      void vscode.window.showWarningMessage(
        editor.selections.every((selection) => selection.isEmpty)
          ? "This line is empty. Select some text to highlight."
          : "Select some text to highlight."
      );
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
    const color = await pickColor(this.renderer.colors, "CodeLight");
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
    const saved = await this.store.transaction((annotations) => {
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
    const root = this.store.rootUri;
    if (!editor || !root) {
      return [];
    }
    const relative = toRelativePath(root, editor.document.uri);
    if (!relative) {
      return [];
    }
    const position = editor.selection.active;
    const spans = this.live.spansFor(editor.document);
    return this.store.forFile(relative).filter((annotation) => {
      if (annotation.orphaned === true) {
        return annotation.range.startLine === position.line;
      }
      const range = this.live.rangeFor(editor.document, annotation, spans);
      return range.isEmpty ? range.start.line === position.line : range.contains(position);
    });
  }

  isCollapsed(annotation: Annotation): boolean {
    const editor = vscode.window.activeTextEditor;
    const root = this.store.rootUri;
    const relative = editor && root ? toRelativePath(root, editor.document.uri) : undefined;
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
    const root = this.store.rootUri;
    if (!editor || !root) {
      return [];
    }
    const relative = toRelativePath(root, editor.document.uri);
    if (!relative) {
      return [];
    }
    const spans = this.live.spansFor(editor.document);
    return this.store.forFile(relative).filter((annotation) => {
      if (annotation.orphaned === true) {
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
    const removed = await this.store.transaction((annotations) => {
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
      void vscode.window.showWarningMessage("That highlight is no longer in the shared file.");
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
      void vscode.window.showWarningMessage("CodeLight could not update the shared file.");
    }
  }

  async removeOrphaned(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const root = this.store.rootUri;
    const relative = editor && root ? toRelativePath(root, editor.document.uri) : undefined;
    if (!relative) {
      void vscode.window.showWarningMessage("Open a tracked file to clean up its highlights.");
      return;
    }
    const orphans = this.store.forFile(relative).filter((annotation) => annotation.orphaned === true);
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
    const saved = await this.store.transaction((annotations) => {
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
      void vscode.window.showWarningMessage("CodeLight could not update the shared file.");
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
    const color = await pickColor(this.renderer.colors, "Change highlight color");
    if (!color) {
      return;
    }
    const saved = await this.store.update(annotation.id, (current) => ({
      ...current,
      color: color.id,
      updatedAt: timestamp()
    }));
    if (!saved) {
      void vscode.window.showWarningMessage("That highlight is no longer in the shared file.");
    }
  }
}

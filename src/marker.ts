import * as vscode from "vscode";
import { HighlightRenderer } from "./decorations";
import { IdentityProvider } from "./identity";
import { HighlightCommands, pickColor } from "./highlights";
import { LiveRanges } from "./live";
import { PaletteColor } from "./palette";
import { toRelativePath } from "./paths";
import { AnnotationStore } from "./store";
import { Visibility } from "./visibility";

const SETTLE_MS = 600;

interface Marked {
  id: string;
  uri: string;
}

export class MarkerMode implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly status: vscode.StatusBarItem;
  private color: PaletteColor | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private last: Marked | undefined;

  constructor(
    private readonly identity: IdentityProvider,
    private readonly store: AnnotationStore,
    private readonly renderer: HighlightRenderer,
    private readonly highlights: HighlightCommands,
    private readonly live: LiveRanges,
    private readonly visibility: Visibility
  ) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.status.command = "codelight.markerOff";
    this.disposables.push(
      this.status,
      vscode.window.onDidChangeTextEditorSelection((event) => this.onSelection(event)),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.cancel();
        this.last = undefined;
      })
    );
    void vscode.commands.executeCommand("setContext", "codelight.marker", false);
  }

  get active(): boolean {
    return this.color !== undefined;
  }

  async toggle(): Promise<void> {
    if (this.color) {
      this.off();
      return;
    }
    const editor = vscode.window.activeTextEditor;
    const root = this.store.rootUri;
    if (!editor || !root || !toRelativePath(root, editor.document.uri)) {
      void vscode.window.showWarningMessage(
        "Open a file inside the workspace folder to use the marker."
      );
      return;
    }
    const author = await this.identity.require();
    if (!author) {
      return;
    }
    const picked = await pickColor(this.renderer.colors, "Marker");
    if (!picked) {
      return;
    }
    this.visibility.show();
    this.color = picked;
    this.last = undefined;
    this.status.text = `$(edit) Marker ${picked.label}`;
    this.status.tooltip = "CodeLight marker is on. Select text to highlight it. Click to turn off.";
    this.status.show();
    void vscode.commands.executeCommand("setContext", "codelight.marker", true);
  }

  off(): void {
    this.cancel();
    this.color = undefined;
    this.last = undefined;
    this.status.hide();
    void vscode.commands.executeCommand("setContext", "codelight.marker", false);
  }

  private relativePath(editor: vscode.TextEditor): string | undefined {
    const root = this.store.rootUri;
    return root ? toRelativePath(root, editor.document.uri) : undefined;
  }

  private cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private onSelection(event: vscode.TextEditorSelectionChangeEvent): void {
    if (!this.color || this.busy) {
      return;
    }
    if (
      event.kind !== vscode.TextEditorSelectionChangeKind.Mouse &&
      event.kind !== vscode.TextEditorSelectionChangeKind.Keyboard
    ) {
      return;
    }
    if (event.textEditor !== vscode.window.activeTextEditor) {
      return;
    }
    const root = this.store.rootUri;
    if (!root || !toRelativePath(root, event.textEditor.document.uri)) {
      return;
    }
    this.cancel();
    if (event.selections.every((selection) => selection.isEmpty)) {
      this.last = undefined;
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.mark(event.textEditor);
    }, SETTLE_MS);
  }

  private async mark(editor: vscode.TextEditor): Promise<void> {
    const color = this.color;
    if (!color || editor !== vscode.window.activeTextEditor) {
      return;
    }
    const ranges = editor.selections
      .filter((selection) => !selection.isEmpty)
      .map((selection) => new vscode.Range(selection.start, selection.end));
    if (ranges.length === 0) {
      return;
    }
    const previous = this.last;
    const relative = this.relativePath(editor);
    if (relative) {
      const taken = this.highlights.markedRanges(editor, relative);
      if (ranges.every((range) => taken.some((existing) => existing.isEqual(range)))) {
        this.last = undefined;
        this.catchUp(editor, ranges);
        return;
      }
    }
    this.busy = true;
    try {
      const created = await this.highlights.add(color, ranges, editor);
      if (created.length > 0 && this.color && editor === vscode.window.activeTextEditor) {
        await this.dropPrevious(previous, editor, ranges);
        this.last =
          this.color && ranges.length === 1
            ? { id: created[0].id, uri: editor.document.uri.toString() }
            : undefined;
      }
    } finally {
      this.busy = false;
    }
    this.catchUp(editor, ranges);
  }

  private async dropPrevious(
    previous: Marked | undefined,
    editor: vscode.TextEditor,
    ranges: readonly vscode.Range[]
  ): Promise<void> {
    if (!previous || ranges.length !== 1) {
      return;
    }
    if (previous.uri !== editor.document.uri.toString()) {
      return;
    }
    const annotation = this.store.byId(previous.id);
    if (!annotation || annotation.comments.length > 0) {
      return;
    }
    const live = this.live.rangeFor(editor.document, annotation);
    const overlap = ranges[0].intersection(live);
    if (live.isEmpty || overlap === undefined || overlap.isEmpty) {
      return;
    }
    await this.store.transaction((annotations) => {
      const current = annotations.get(previous.id);
      if (!current || current.comments.length > 0) {
        return false;
      }
      annotations.delete(previous.id);
      return true;
    });
  }

  private catchUp(editor: vscode.TextEditor, marked: readonly vscode.Range[]): void {
    if (!this.color || editor !== vscode.window.activeTextEditor) {
      return;
    }
    const current = editor.selections.filter((selection) => !selection.isEmpty);
    if (current.length === 0) {
      return;
    }
    const same =
      current.length === marked.length &&
      current.every((selection, index) => selection.isEqual(marked[index]));
    if (same) {
      return;
    }
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.mark(editor);
    }, SETTLE_MS);
  }

  dispose(): void {
    this.cancel();
    void vscode.commands.executeCommand("setContext", "codelight.marker", false);
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

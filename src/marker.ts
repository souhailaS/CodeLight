import * as vscode from "vscode";
import { HighlightRenderer } from "./decorations";
import { IdentityProvider } from "./identity";
import { HighlightCommands, pickColor } from "./highlights";
import { timestamp } from "./ids";
import { LiveRanges } from "./live";
import { PaletteColor } from "./palette";
import { AnnotationStore } from "./store";
import { Visibility } from "./visibility";

const SETTLE_MS = 600;

interface Marked {
  ids: string[];
  uri: string;
  color: string;
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
    this.disposables.push(
      visibility.onDidChange((shown) => {
        if (!shown) {
          this.off();
        }
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
    if (!editor || this.store.relative(editor.document.uri) === undefined) {
      void vscode.window.showWarningMessage(
        "Open a file inside a folder of this workspace to use the marker."
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

  private async recolorExisting(
    editor: vscode.TextEditor,
    ranges: readonly vscode.Range[],
    color: PaletteColor
  ): Promise<boolean> {
    const spans = this.live.spansFor(editor.document);
    const matches: string[] = [];
    for (const range of ranges) {
      const me = this.identity.identity?.id;
      const hit = this.store.forFile(editor.document.uri).find((annotation) => {
        if (annotation.orphaned === true || annotation.comments.length > 0) {
          return false;
        }
        if (me === undefined || annotation.author.id !== me) {
          return false;
        }
        return this.live.rangeFor(editor.document, annotation, spans).isEqual(range);
      });
      if (!hit) {
        return false;
      }
      matches.push(hit.id);
    }
    const stale = matches.filter((id) => this.store.byId(id)?.color !== color.id);
    if (stale.length > 0) {
      const saved = await this.store.transaction(editor.document.uri, (annotations) => {
        let changed = false;
        for (const id of stale) {
          const current = annotations.get(id);
          if (!current) {
            continue;
          }
          annotations.set(id, { ...current, color: color.id, updatedAt: timestamp() });
          changed = true;
        }
        return changed;
      });
      if (!saved) {
        void vscode.window.showWarningMessage("CodeLight could not update the shared file.");
      }
    }
    this.last = undefined;
    return true;
  }

  private cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private onSelection(event: vscode.TextEditorSelectionChangeEvent): void {
    if (!this.color || event.textEditor !== vscode.window.activeTextEditor) {
      return;
    }
    if (event.selections.every((selection) => selection.isEmpty)) {
      this.cancel();
      this.last = undefined;
      return;
    }
    if (this.busy) {
      return;
    }
    if (
      event.kind !== vscode.TextEditorSelectionChangeKind.Mouse &&
      event.kind !== vscode.TextEditorSelectionChangeKind.Keyboard
    ) {
      this.cancel();
      return;
    }
    if (this.store.relative(event.textEditor.document.uri) === undefined) {
      return;
    }
    this.cancel();
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
    if (this.store.relative(editor.document.uri) !== undefined) {
      const recolored = await this.recolorExisting(editor, ranges, color);
      if (recolored) {
        this.catchUp(editor, ranges);
        return;
      }
    }
    this.busy = true;
    try {
      const created = await this.highlights.add(color, ranges, editor);
      if (created.length > 0 && this.color && editor === vscode.window.activeTextEditor) {
        await this.dropPrevious(previous, editor, ranges);
        this.last = this.color
          ? {
              ids: created.map((annotation) => annotation.id),
              uri: editor.document.uri.toString(),
              color: this.color.id
            }
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
    if (!previous || previous.uri !== editor.document.uri.toString()) {
      return;
    }
    const doomed: string[] = [];
    for (const id of previous.ids) {
      const annotation = this.store.byId(id);
      if (!annotation || annotation.comments.length > 0 || annotation.color !== previous.color) {
        continue;
      }
      const live = this.live.rangeFor(editor.document, annotation);
      if (live.isEmpty) {
        continue;
      }
      const nested = ranges.some(
        (range) => !range.isEqual(live) && (range.contains(live) || live.contains(range))
      );
      if (nested) {
        doomed.push(id);
      }
    }
    if (doomed.length === 0) {
      return;
    }
    const saved = await this.store.transaction(editor.document.uri, (annotations) => {
      let changed = false;
      for (const id of doomed) {
        const current = annotations.get(id);
        if (!current || current.comments.length > 0) {
          continue;
        }
        annotations.delete(id);
        changed = true;
      }
      return changed;
    });
    if (!saved) {
      void vscode.window.showWarningMessage("CodeLight could not update the shared file.");
    }
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

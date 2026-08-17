import * as vscode from "vscode";
import { buildAnchor } from "./anchors";
import { HighlightRenderer } from "./decorations";
import { HighlightCommands, pickColor } from "./highlights";
import { timestamp } from "./ids";
import { PaletteColor } from "./palette";
import { toRelativePath } from "./paths";
import { AnnotationStore } from "./store";

const SETTLE_MS = 600;

interface Marked {
  id: string;
  uri: string;
  range: vscode.Range;
}

export class MarkerMode implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly status: vscode.StatusBarItem;
  private color: PaletteColor | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private last: Marked | undefined;

  constructor(
    private readonly store: AnnotationStore,
    private readonly renderer: HighlightRenderer,
    private readonly highlights: HighlightCommands
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
    const picked = await pickColor(this.renderer.colors, "Marker");
    if (!picked) {
      return;
    }
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
    this.busy = true;
    try {
      if (await this.extend(editor, ranges)) {
        return;
      }
      const created = await this.highlights.add(color, ranges);
      if (created.length === 0) {
        this.off();
        void vscode.window.showInformationMessage("CodeLight turned the marker off.");
        return;
      }
      const first = created[0];
      this.last = {
        id: first.id,
        uri: editor.document.uri.toString(),
        range: ranges[0]
      };
    } finally {
      this.busy = false;
    }
  }

  private async extend(editor: vscode.TextEditor, ranges: vscode.Range[]): Promise<boolean> {
    const previous = this.last;
    if (!previous || ranges.length !== 1) {
      return false;
    }
    if (previous.uri !== editor.document.uri.toString()) {
      return false;
    }
    const grown = ranges[0];
    if (!grown.contains(previous.range) || grown.isEqual(previous.range)) {
      return false;
    }
    if (!this.store.byId(previous.id)) {
      this.last = undefined;
      return false;
    }
    const text = editor.document.getText();
    const saved = await this.store.update(previous.id, (current) => ({
      ...current,
      updatedAt: timestamp(),
      range: {
        startLine: grown.start.line,
        startCharacter: grown.start.character,
        endLine: grown.end.line,
        endCharacter: grown.end.character
      },
      anchor: buildAnchor(text, editor.document.offsetAt(grown.start), editor.document.offsetAt(grown.end))
    }));
    if (!saved) {
      this.last = undefined;
      return false;
    }
    this.last = { id: previous.id, uri: previous.uri, range: grown };
    return true;
  }

  dispose(): void {
    this.cancel();
    void vscode.commands.executeCommand("setContext", "codelight.marker", false);
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

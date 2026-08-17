import * as vscode from "vscode";
import { HighlightRenderer } from "./decorations";
import { HighlightCommands, pickColor } from "./highlights";
import { PaletteColor } from "./palette";
import { toRelativePath } from "./paths";
import { AnnotationStore } from "./store";

const SETTLE_MS = 350;

export class MarkerMode implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly status: vscode.StatusBarItem;
  private color: PaletteColor | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;

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
      vscode.window.onDidChangeActiveTextEditor(() => this.cancel())
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
    this.status.text = `$(edit) Marker ${picked.label}`;
    this.status.tooltip = "CodeLight marker is on. Select text to highlight it. Click to turn off.";
    this.status.show();
    void vscode.commands.executeCommand("setContext", "codelight.marker", true);
  }

  off(): void {
    this.cancel();
    this.color = undefined;
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
    if (event.textEditor !== vscode.window.activeTextEditor) {
      return;
    }
    const root = this.store.rootUri;
    const relative = root ? toRelativePath(root, event.textEditor.document.uri) : undefined;
    if (!relative) {
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
    if (editor.selections.every((selection) => selection.isEmpty)) {
      return;
    }
    this.busy = true;
    try {
      const created = await this.highlights.add(color);
      if (created.length > 0 && editor === vscode.window.activeTextEditor) {
        const end = editor.selection.end;
        editor.selection = new vscode.Selection(end, end);
      }
    } finally {
      this.busy = false;
    }
  }

  dispose(): void {
    this.cancel();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

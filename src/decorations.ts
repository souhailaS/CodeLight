import * as vscode from "vscode";
import { Annotation } from "./model";
import { PaletteColor, readOpacity, readPalette, toRgba } from "./palette";
import { toRelativePath } from "./paths";
import { AnnotationStore } from "./store";

export class HighlightRenderer implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private types = new Map<string, vscode.TextEditorDecorationType>();
  private palette: PaletteColor[] = [];

  constructor(private readonly store: AnnotationStore) {
    this.rebuild();
    this.disposables.push(
      store.onDidChange(() => this.renderAll()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.renderAll()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration("codelight.palette") ||
          event.affectsConfiguration("codelight.highlightOpacity")
        ) {
          this.rebuild();
          this.renderAll();
        }
      })
    );
  }

  get colors(): readonly PaletteColor[] {
    return this.palette;
  }

  renderAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.render(editor);
    }
  }

  render(editor: vscode.TextEditor): void {
    const root = this.store.rootUri;
    const relative = root ? toRelativePath(root, editor.document.uri) : undefined;
    const annotations = relative ? this.store.forFile(relative) : [];
    const grouped = new Map<string, vscode.Range[]>();
    for (const key of this.types.keys()) {
      grouped.set(key, []);
    }
    for (const annotation of annotations) {
      const key = this.types.has(annotation.color) ? annotation.color : this.fallbackId();
      const ranges = grouped.get(key);
      if (ranges) {
        ranges.push(this.toRange(editor.document, annotation));
      }
    }
    for (const [key, ranges] of grouped) {
      const type = this.types.get(key);
      if (type) {
        editor.setDecorations(type, ranges);
      }
    }
  }

  private fallbackId(): string {
    return this.palette[0]?.id ?? "yellow";
  }

  private toRange(document: vscode.TextDocument, annotation: Annotation): vscode.Range {
    const range = new vscode.Range(
      annotation.range.startLine,
      annotation.range.startCharacter,
      annotation.range.endLine,
      annotation.range.endCharacter
    );
    return document.validateRange(range);
  }

  private rebuild(): void {
    for (const type of this.types.values()) {
      type.dispose();
    }
    this.types = new Map();
    this.palette = readPalette();
    const opacity = readOpacity();
    for (const color of this.palette) {
      this.types.set(
        color.id,
        vscode.window.createTextEditorDecorationType({
          backgroundColor: toRgba(color.hex, opacity),
          borderRadius: "2px",
          overviewRulerColor: color.hex,
          overviewRulerLane: vscode.OverviewRulerLane.Right,
          rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
        })
      );
    }
  }

  dispose(): void {
    for (const type of this.types.values()) {
      type.dispose();
    }
    this.types = new Map();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

import * as vscode from "vscode";
import { LiveRanges } from "./live";
import { PaletteColor, readOpacity, readPalette, resolveColor, toRgba } from "./palette";
import { toRelativePath } from "./paths";
import { AnnotationStore } from "./store";

export class HighlightRenderer implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private types = new Map<string, vscode.TextEditorDecorationType>();
  private palette: PaletteColor[] = [];
  private paletteRoot: string | undefined;

  constructor(
    private readonly store: AnnotationStore,
    private readonly live: LiveRanges
  ) {
    this.rebuild();
    this.disposables.push(
      store.onDidChange(() => {
        if (this.paletteRoot !== this.store.rootUri?.toString()) {
          this.rebuild();
        }
        this.renderAll();
      }),
      live.onDidShift((document) => this.renderDocument(document)),
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
    this.renderAll();
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
    const spans = annotations.length > 0 ? this.live.spansFor(editor.document) : undefined;
    const grouped = new Map<string, vscode.Range[]>();
    for (const key of this.types.keys()) {
      grouped.set(key, []);
    }
    for (const annotation of annotations) {
      if (annotation.orphaned === true) {
        continue;
      }
      const key = this.types.has(annotation.color)
        ? annotation.color
        : resolveColor(this.palette, annotation.color).id;
      const ranges = grouped.get(key);
      if (ranges) {
        ranges.push(this.live.rangeFor(editor.document, annotation, spans));
      }
    }
    for (const [key, ranges] of grouped) {
      const type = this.types.get(key);
      if (type) {
        editor.setDecorations(type, ranges);
      }
    }
  }

  private renderDocument(document: vscode.TextDocument): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document === document) {
        this.render(editor);
      }
    }
  }

  private rebuild(): void {
    for (const type of this.types.values()) {
      type.dispose();
    }
    this.types = new Map();
    const resource = this.store.rootUri;
    this.paletteRoot = resource?.toString();
    this.palette = readPalette(resource);
    const opacity = readOpacity(resource);
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

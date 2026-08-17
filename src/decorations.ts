import * as vscode from "vscode";
import { LiveRanges } from "./live";
import { PaletteColor, readInlineMode, readOpacity, readPalette, resolveColor, toRgba } from "./palette";
import { toRelativePath } from "./paths";
import { AnnotationStore } from "./store";
import { InlineMode, inlineLabel, threadMarkdown } from "./thread";

export class HighlightRenderer implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private types = new Map<string, vscode.TextEditorDecorationType>();
  private palette: PaletteColor[] = [];
  private paletteRoot: string | undefined;
  private badge: vscode.TextEditorDecorationType | undefined;
  private inline: InlineMode = "preview";

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
          event.affectsConfiguration("codelight.highlightOpacity") ||
          event.affectsConfiguration("codelight.inlineComments")
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
    const grouped = new Map<string, vscode.DecorationOptions[]>();
    for (const key of this.types.keys()) {
      grouped.set(key, []);
    }
    const badges: vscode.DecorationOptions[] = [];
    for (const annotation of annotations) {
      if (annotation.orphaned === true) {
        continue;
      }
      const key = this.types.has(annotation.color)
        ? annotation.color
        : resolveColor(this.palette, annotation.color).id;
      const options = grouped.get(key);
      if (!options) {
        continue;
      }
      const range = this.live.rangeFor(editor.document, annotation, spans);
      options.push({ range, hoverMessage: threadMarkdown(annotation) });
      const label = inlineLabel(annotation, this.inline);
      if (label !== undefined) {
        badges.push({
          range: new vscode.Range(range.end, range.end),
          renderOptions: { after: { contentText: label } }
        });
      }
    }
    for (const [key, options] of grouped) {
      const type = this.types.get(key);
      if (type) {
        editor.setDecorations(type, options);
      }
    }
    if (this.badge) {
      editor.setDecorations(this.badge, badges);
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
    this.inline = readInlineMode(resource);
    this.badge?.dispose();
    this.badge = vscode.window.createTextEditorDecorationType({
      after: {
        color: new vscode.ThemeColor("editorCodeLens.foreground"),
        fontStyle: "italic",
        margin: "0 0 0 1rem"
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    });
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
    this.badge?.dispose();
    this.badge = undefined;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

import * as vscode from "vscode";
import { LiveRanges } from "./live";
import { Annotation } from "./model";
import {
  PaletteColor,
  readGutterMarks,
  readInlineMode,
  readOpacity,
  readPalette,
  resolveColor,
  toRgba
} from "./palette";
import { AnnotationStore } from "./store";
import { Visibility } from "./visibility";
import { InlineMode, inlineLabel, threadMarkdown } from "./thread";

export class HighlightRenderer implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private types = new Map<string, vscode.TextEditorDecorationType>();
  private palette: PaletteColor[] = [];
  private paletteRoot: string | undefined;
  private badge: vscode.TextEditorDecorationType | undefined;
  private gutters = new Map<string, vscode.TextEditorDecorationType>();
  private hovers = new Map<string, vscode.MarkdownString>();
  private inline: InlineMode = "preview";

  constructor(
    private readonly store: AnnotationStore,
    private readonly live: LiveRanges,
    private readonly visibility: Visibility
  ) {
    this.rebuild();
    this.disposables.push(
      store.onDidChange(() => {
        this.hovers = new Map();
        if (this.paletteRoot !== this.store.rootUri?.toString()) {
          this.rebuild();
        }
        this.renderAll();
      }),
      live.onDidShift((document) => this.renderDocument(document)),
      visibility.onDidChange(() => this.renderAll()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.renderAll()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration("codelight.palette") ||
          event.affectsConfiguration("codelight.highlightOpacity") ||
          event.affectsConfiguration("codelight.inlineComments") ||
          event.affectsConfiguration("codelight.gutterMarks")
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
    const annotations = this.visibility.visible ? this.store.forFile(editor.document.uri) : [];
    const spans = annotations.length > 0 ? this.live.spansFor(editor.document) : undefined;
    const grouped = new Map<string, vscode.DecorationOptions[]>();
    for (const key of this.types.keys()) {
      grouped.set(key, []);
    }
    const labels = new Map<number, string[]>();
    const marks = new Map<string, vscode.Range[]>();
    for (const key of this.types.keys()) {
      marks.set(key, []);
    }
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
      options.push({ range, hoverMessage: this.hover(annotation) });
      const gutter = marks.get(key);
      if (gutter && !range.isEmpty) {
        const last =
          range.end.character === 0 && range.end.line > range.start.line
            ? range.end.line - 1
            : range.end.line;
        gutter.push(new vscode.Range(range.start.line, 0, last, 0));
      }
      const label = range.isEmpty ? undefined : inlineLabel(annotation, this.inline);
      if (label !== undefined) {
        const anchorLine =
          range.end.character === 0 && range.end.line > range.start.line
            ? range.end.line - 1
            : range.end.line;
        const line = labels.get(anchorLine) ?? [];
        line.push(label.trim());
        labels.set(anchorLine, line);
      }
    }
    for (const [key, options] of grouped) {
      const type = this.types.get(key);
      if (type) {
        editor.setDecorations(type, options);
      }
    }
    for (const [key, ranges] of marks) {
      const type = this.gutters.get(key);
      if (type) {
        editor.setDecorations(type, ranges);
      }
    }
    if (this.badge) {
      const badges: vscode.DecorationOptions[] = [];
      for (const [line, parts] of labels) {
        const lineEnd = editor.document.lineAt(line).range.end;
        badges.push({
          range: new vscode.Range(lineEnd, lineEnd),
          renderOptions: { after: { contentText: ` ${parts.join("  ·  ")}` } }
        });
      }
      editor.setDecorations(this.badge, badges);
    }
  }

  private hover(annotation: Annotation): vscode.MarkdownString {
    const key = `${annotation.id}:${annotation.updatedAt}`;
    const cached = this.hovers.get(key);
    if (cached) {
      return cached;
    }
    const markdown = threadMarkdown(annotation);
    this.hovers.set(key, markdown);
    return markdown;
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
    for (const type of this.gutters.values()) {
      type.dispose();
    }
    this.types = new Map();
    this.gutters = new Map();
    const resource = this.store.rootUri;
    this.paletteRoot = resource?.toString();
    this.palette = readPalette(resource);
    const opacity = readOpacity(resource);
    this.inline = readInlineMode(resource);
    const marks = readGutterMarks(resource);
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
          outline: `1px solid ${toRgba(color.hex, Math.min(1, opacity + 0.22))}`,
          borderRadius: "3px",
          overviewRulerColor: color.hex,
          overviewRulerLane: vscode.OverviewRulerLane.Right,
          rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
        })
      );
      if (marks) {
        this.gutters.set(
          color.id,
          vscode.window.createTextEditorDecorationType({
            gutterIconPath: this.gutterIcon(color.hex),
            gutterIconSize: "auto"
          })
        );
      }
    }
  }

  private gutterIcon(hex: string): vscode.Uri {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14"><rect x="5" y="1.5" width="4" height="11" rx="2" fill="${hex}"/></svg>`;
    return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`);
  }

  dispose(): void {
    for (const type of this.types.values()) {
      type.dispose();
    }
    for (const type of this.gutters.values()) {
      type.dispose();
    }
    this.types = new Map();
    this.gutters = new Map();
    this.badge?.dispose();
    this.badge = undefined;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

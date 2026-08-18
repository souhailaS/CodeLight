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

interface Style {
  palette: PaletteColor[];
  inline: InlineMode;
  released: boolean;
  types: Map<string, vscode.TextEditorDecorationType>;
  gutters: Map<string, vscode.TextEditorDecorationType>;
}

export class HighlightRenderer implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private styles = new Map<string, Style>();
  private painted = new WeakMap<vscode.TextEditor, Style>();
  private closed = false;
  private badge: vscode.TextEditorDecorationType | undefined;
  private hovers = new Map<string, vscode.MarkdownString>();

  constructor(
    private readonly store: AnnotationStore,
    private readonly live: LiveRanges,
    private readonly visibility: Visibility
  ) {
    this.rebuild();
    this.disposables.push(
      store.onDidChange(() => {
        this.hovers = new Map();
        this.prune();
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

  colorsFor(target: vscode.Uri | undefined): readonly PaletteColor[] {
    return this.styleFor(target ? this.store.rootFor(target) : undefined).palette;
  }

  renderAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.render(editor);
    }
  }

  render(editor: vscode.TextEditor): void {
    const style = this.styleFor(this.store.rootFor(editor.document.uri));
    const annotations = this.visibility.visible ? this.store.forFile(editor.document.uri) : [];
    const spans = annotations.length > 0 ? this.live.spansFor(editor.document) : undefined;
    const grouped = new Map<string, vscode.DecorationOptions[]>();
    for (const key of style.types.keys()) {
      grouped.set(key, []);
    }
    const labels = new Map<number, string[]>();
    const marks = new Map<string, vscode.Range[]>();
    for (const key of style.types.keys()) {
      marks.set(key, []);
    }
    for (const annotation of annotations) {
      if (annotation.orphaned === true) {
        continue;
      }
      const key = style.types.has(annotation.color)
        ? annotation.color
        : resolveColor(style.palette, annotation.color).id;
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
      const label = range.isEmpty ? undefined : inlineLabel(annotation, style.inline);
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
    const previous = this.painted.get(editor);
    if (previous && previous !== style && !previous.released) {
      for (const type of previous.types.values()) {
        editor.setDecorations(type, []);
      }
      for (const type of previous.gutters.values()) {
        editor.setDecorations(type, []);
      }
    }
    this.painted.set(editor, style);
    for (const [key, options] of grouped) {
      const type = style.types.get(key);
      if (type) {
        editor.setDecorations(type, options);
      }
    }
    for (const [key, ranges] of marks) {
      const type = style.gutters.get(key);
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

  private styleFor(resource: vscode.Uri | undefined): Style {
    const key = resource?.toString() ?? "";
    const known = this.styles.get(key);
    if (known) {
      return known;
    }
    if (this.closed) {
      return { palette: [], inline: "off", released: true, types: new Map(), gutters: new Map() };
    }
    const palette = readPalette(resource);
    const opacity = readOpacity(resource);
    const marks = readGutterMarks(resource);
    const style: Style = {
      palette,
      inline: readInlineMode(resource),
      released: false,
      types: new Map(),
      gutters: new Map()
    };
    for (const color of palette) {
      style.types.set(
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
        style.gutters.set(
          color.id,
          vscode.window.createTextEditorDecorationType({
            gutterIconPath: this.gutterIcon(color.hex),
            gutterIconSize: "auto"
          })
        );
      }
    }
    this.styles.set(key, style);
    return style;
  }

  private release(style: Style): void {
    style.released = true;
    for (const type of style.types.values()) {
      type.dispose();
    }
    for (const type of style.gutters.values()) {
      type.dispose();
    }
  }

  private prune(): void {
    const known = new Set(this.store.folders.map((folder) => folder.key));
    for (const [key, style] of [...this.styles]) {
      if (key === "" || known.has(key)) {
        continue;
      }
      this.release(style);
      this.styles.delete(key);
    }
  }

  private rebuild(): void {
    for (const style of this.styles.values()) {
      this.release(style);
    }
    this.styles = new Map();
    if (this.badge) {
      return;
    }
    this.badge = vscode.window.createTextEditorDecorationType({
      after: {
        color: new vscode.ThemeColor("editorCodeLens.foreground"),
        fontStyle: "italic",
        margin: "0 0 0 1rem"
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    });
  }

  private gutterIcon(hex: string): vscode.Uri {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14"><rect x="5" y="1.5" width="4" height="11" rx="2" fill="${hex}"/></svg>`;
    return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`);
  }

  dispose(): void {
    this.closed = true;
    for (const style of this.styles.values()) {
      this.release(style);
    }
    this.styles = new Map();
    this.badge?.dispose();
    this.badge = undefined;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

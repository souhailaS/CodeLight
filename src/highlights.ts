import * as vscode from "vscode";
import { HighlightRenderer } from "./decorations";
import { newId, timestamp } from "./ids";
import { IdentityProvider } from "./identity";
import { LiveRanges } from "./live";
import { Anchor, Annotation } from "./model";
import { DEFAULT_PALETTE, PaletteColor } from "./palette";
import { toRelativePath } from "./paths";
import { AnnotationStore } from "./store";

const ANCHOR_CONTEXT = 60;
const MAX_ANCHOR_TEXT = 400;
const SNIPPET_LENGTH = 50;

function buildAnchor(document: vscode.TextDocument, range: vscode.Range): Anchor {
  const offset = document.offsetAt(range.start);
  const endOffset = document.offsetAt(range.end);
  const whole = document.getText();
  return {
    text: whole.slice(offset, endOffset).slice(0, MAX_ANCHOR_TEXT),
    before: whole.slice(Math.max(0, offset - ANCHOR_CONTEXT), offset),
    after: whole.slice(endOffset, endOffset + ANCHOR_CONTEXT)
  };
}

function snippet(annotation: Annotation): string {
  const text = annotation.anchor.text.replace(/\s+/g, " ").trim();
  if (text.length <= SNIPPET_LENGTH) {
    return text === "" ? "empty selection" : text;
  }
  return `${text.slice(0, SNIPPET_LENGTH)}…`;
}

function colorIcon(color: PaletteColor): vscode.ThemeIcon {
  const isDefault = DEFAULT_PALETTE.some((entry) => entry.id === color.id);
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

  async add(): Promise<Annotation | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage("Open a file to highlight.");
      return undefined;
    }
    const root = this.store.rootUri;
    const relative = root ? toRelativePath(root, editor.document.uri) : undefined;
    if (!relative) {
      void vscode.window.showWarningMessage("CodeLight only tracks files inside the workspace folder.");
      return undefined;
    }
    const range = editor.selection.isEmpty
      ? editor.document.lineAt(editor.selection.active.line).range
      : new vscode.Range(editor.selection.start, editor.selection.end);
    if (range.isEmpty) {
      void vscode.window.showWarningMessage("Select some text to highlight.");
      return undefined;
    }
    const anchor = buildAnchor(editor.document, range);
    const version = editor.document.version;
    const author = await this.identity.require();
    if (!author) {
      return undefined;
    }
    const color = await pickColor(this.renderer.colors, "CodeLight");
    if (!color) {
      return undefined;
    }
    if (editor.document.version !== version) {
      void vscode.window.showWarningMessage("The file changed while the color picker was open. Select the text again.");
      return undefined;
    }
    const now = timestamp();
    const annotation: Annotation = {
      id: newId(),
      file: relative,
      range: {
        startLine: range.start.line,
        startCharacter: range.start.character,
        endLine: range.end.line,
        endCharacter: range.end.character
      },
      anchor,
      color: color.id,
      author: { login: author.login, id: author.id },
      createdAt: now,
      updatedAt: now,
      comments: []
    };
    const saved = await this.store.add(annotation);
    if (!saved) {
      void vscode.window.showWarningMessage("CodeLight could not save the highlight.");
      return undefined;
    }
    return annotation;
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
    return this.store
      .forFile(relative)
      .filter((annotation) => this.live.rangeFor(editor.document, annotation).contains(position));
  }

  async pickAtCursor(title: string): Promise<Annotation | undefined> {
    const candidates = this.atCursor();
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage("No CodeLight highlight at the cursor.");
      return undefined;
    }
    if (candidates.length === 1) {
      return candidates[0];
    }
    const picked = await vscode.window.showQuickPick(
      candidates.map((annotation) => ({
        label: snippet(annotation),
        description: `${annotation.color} by ${annotation.author.login}`,
        annotation
      })),
      { title }
    );
    return picked?.annotation;
  }

  async remove(): Promise<void> {
    const annotation = await this.pickAtCursor("Remove highlight");
    if (!annotation) {
      return;
    }
    if (!(await this.store.remove(annotation.id))) {
      void vscode.window.showWarningMessage("That highlight is no longer in the shared file.");
    }
  }

  async recolor(): Promise<void> {
    const annotation = await this.pickAtCursor("Change highlight color");
    if (!annotation) {
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

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { LiveRanges } from "./live";
import { Comment } from "./model";
import { readPalette } from "./palette";
import { basename } from "./panel";
import { toRelativePath } from "./paths";
import { AnnotationStore } from "./store";
import { formatDate, snippet } from "./thread";

const SHIFT_DEBOUNCE_MS = 250;

interface Card {
  id: string;
  hex: string | undefined;
  label: string;
  line: number;
  orphaned: boolean;
  comments: Comment[];
}

interface FileCards {
  file: string;
  cards: Card[];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function createNonce(): string {
  return randomBytes(16).toString("hex");
}

function styles(): string {
  return [
    "body { margin: 0; padding: 8px; background: var(--vscode-sideBar-background);",
    "  color: var(--vscode-foreground); font-family: var(--vscode-font-family);",
    "  font-size: var(--vscode-font-size); }",
    ".empty { color: var(--vscode-descriptionForeground); }",
    ".file { margin-bottom: 8px; overflow: hidden; text-overflow: ellipsis;",
    "  white-space: nowrap; color: var(--vscode-descriptionForeground); }",
    ".card { border: 1px solid var(--vscode-panel-border); border-radius: 4px;",
    "  padding: 6px 8px; margin-bottom: 6px; cursor: pointer; }",
    ".card:hover { background: var(--vscode-list-hoverBackground); }",
    ".card:focus-visible { outline: 1px solid var(--vscode-textLink-foreground); }",
    ".head { display: flex; align-items: center; gap: 6px; }",
    ".dot { flex: none; width: 8px; height: 8px; border-radius: 50%;",
    "  background: var(--vscode-descriptionForeground); }",
    ".snippet { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;",
    "  white-space: nowrap; color: var(--vscode-textLink-foreground); }",
    ".orphan .snippet { color: var(--vscode-descriptionForeground);",
    "  text-decoration: line-through; }",
    ".orphan .body { color: var(--vscode-descriptionForeground); }",
    ".line { flex: none; font-size: 0.85em; color: var(--vscode-descriptionForeground); }",
    ".comment { margin-top: 6px; }",
    ".comment + .comment { padding-top: 6px; border-top: 1px solid var(--vscode-panel-border); }",
    ".meta { font-size: 0.85em; color: var(--vscode-descriptionForeground); }",
    ".body { margin-top: 2px; white-space: pre-wrap; overflow-wrap: anywhere; }"
  ].join("\n");
}

function script(): string {
  return [
    "const bridge = acquireVsCodeApi();",
    "const key = document.body.dataset.key;",
    "const saved = bridge.getState();",
    "if (saved && saved.key === key && typeof saved.scroll === 'number') {",
    "  window.scrollTo(0, saved.scroll);",
    "}",
    "window.addEventListener('scroll', () => {",
    "  bridge.setState({ key: key, scroll: window.scrollY });",
    "});",
    "for (const card of document.querySelectorAll('.card')) {",
    "  const send = () => bridge.postMessage({ type: 'reveal', id: card.dataset.id });",
    "  card.addEventListener('click', send);",
    "  card.addEventListener('keydown', (event) => {",
    "    if (event.key === 'Enter' || event.key === ' ') {",
    "      event.preventDefault();",
    "      send();",
    "    }",
    "  });",
    "}"
  ].join("\n");
}

function renderNote(text: string): string {
  return `<p class="empty">${escapeHtml(text)}</p>`;
}

function renderHeader(file: string): string {
  return `<div class="file" title="${escapeHtml(file)}">${escapeHtml(basename(file))}</div>`;
}

function renderComment(comment: Comment): string {
  const when = formatDate(comment.createdAt);
  const who = escapeHtml(`@${comment.author.login}`);
  const meta = when === "" ? who : `${who} · ${escapeHtml(when)}`;
  return [
    `<div class="comment">`,
    `<div class="meta">${meta}</div>`,
    `<div class="body">${escapeHtml(comment.body)}</div>`,
    `</div>`
  ].join("");
}

function renderCard(card: Card): string {
  const dot =
    card.hex === undefined || card.orphaned
      ? `<span class="dot"></span>`
      : `<span class="dot" style="background: ${escapeHtml(card.hex)}"></span>`;
  const classes = card.orphaned ? "card orphan" : "card";
  const note = card.orphaned ? "text deleted" : `Line ${card.line}`;
  return [
    `<div class="${classes}" role="button" tabindex="0" data-id="${escapeHtml(card.id)}">`,
    `<div class="head">`,
    dot,
    `<span class="snippet">${escapeHtml(card.label)}</span>`,
    `<span class="line">${note}</span>`,
    `</div>`,
    card.comments.map(renderComment).join(""),
    `</div>`
  ].join("");
}

export class FileCommentsView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = "codelight.fileComments";

  private readonly disposables: vscode.Disposable[] = [];
  private bound: vscode.Disposable[] = [];
  private view: vscode.WebviewView | undefined;
  private nonce = createNonce();
  private tracked: vscode.TextEditor | undefined;
  private shown: string | undefined;
  private shiftTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly store: AnnotationStore,
    private readonly live: LiveRanges
  ) {
    this.disposables.push(
      store.onDidChange(() => this.render()),
      live.onDidShift((document) => this.scheduleShift(document)),
      vscode.window.onDidChangeActiveTextEditor(() => this.render()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.render()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("codelight.palette")) {
          this.render();
        }
      })
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.unbind();
    this.view = view;
    this.nonce = createNonce();
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    this.bound.push(
      view.webview.onDidReceiveMessage((message: unknown) => this.receive(message)),
      view.onDidChangeVisibility(() => this.render()),
      view.onDidDispose(() => this.unbind())
    );
    this.render();
  }

  refresh(): void {
    this.render();
  }

  private unbind(): void {
    this.view = undefined;
    this.shown = undefined;
    for (const disposable of this.bound) {
      disposable.dispose();
    }
    this.bound = [];
  }

  private scheduleShift(document: vscode.TextDocument): void {
    const view = this.view;
    if (!view || !view.visible || this.shown !== document.uri.toString()) {
      return;
    }
    if (this.shiftTimer) {
      clearTimeout(this.shiftTimer);
    }
    this.shiftTimer = setTimeout(() => {
      this.shiftTimer = undefined;
      this.render();
    }, SHIFT_DEBOUNCE_MS);
  }

  private receive(message: unknown): void {
    if (typeof message !== "object" || message === null) {
      return;
    }
    const payload = message as { type?: unknown; id?: unknown };
    if (payload.type !== "reveal" || typeof payload.id !== "string") {
      return;
    }
    void vscode.commands.executeCommand("codelight.revealAnnotation", payload.id);
  }

  private render(): void {
    const view = this.view;
    if (!view || !view.visible) {
      return;
    }
    const editor = this.editor();
    this.shown = editor ? editor.document.uri.toString() : undefined;
    view.webview.html = this.html(view.webview, editor);
  }

  private editor(): vscode.TextEditor | undefined {
    const active = vscode.window.activeTextEditor;
    if (active) {
      this.tracked = active;
      return active;
    }
    const previous = this.tracked?.document.uri.toString();
    const still = previous
      ? vscode.window.visibleTextEditors.find(
          (candidate) => candidate.document.uri.toString() === previous
        )
      : undefined;
    this.tracked = still ?? vscode.window.visibleTextEditors[0];
    return this.tracked;
  }

  private collect(editor: vscode.TextEditor | undefined): FileCards | undefined {
    const root = this.store.rootUri;
    if (!editor || !root) {
      return undefined;
    }
    const relative = toRelativePath(root, editor.document.uri);
    if (relative === undefined) {
      return undefined;
    }
    const document = editor.document;
    const palette = readPalette(root);
    const annotations = this.store
      .forFile(relative)
      .filter((annotation) => annotation.comments.length > 0);
    const spans = annotations.length > 0 ? this.live.spansFor(document) : undefined;
    const cards = annotations
      .map((annotation) => ({
        annotation,
        range: this.live.rangeFor(document, annotation, spans)
      }))
      .sort((a, b) => a.range.start.compareTo(b.range.start))
      .map(({ annotation, range }) => ({
        id: annotation.id,
        hex: palette.find((color) => color.id === annotation.color)?.hex,
        label: snippet(annotation),
        line: range.start.line + 1,
        orphaned: annotation.orphaned === true,
        comments: annotation.comments
      }));
    return { file: relative, cards };
  }

  private body(editor: vscode.TextEditor | undefined): string {
    if (this.store.all.length === 0) {
      return renderNote("This project has no CodeLight annotations yet.");
    }
    const found = this.collect(editor);
    if (!found) {
      return renderNote("Open a file from this workspace to see its comments.");
    }
    const header = renderHeader(found.file);
    if (found.cards.length === 0) {
      return `${header}${renderNote("No comments in this file yet.")}`;
    }
    return header + found.cards.map(renderCard).join("");
  }

  private html(webview: vscode.Webview, editor: vscode.TextEditor | undefined): string {
    const nonce = this.nonce;
    const key = editor ? editor.document.uri.toString() : "";
    const policy = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`
    ].join("; ");
    return [
      `<!DOCTYPE html>`,
      `<html lang="en">`,
      `<head>`,
      `<meta charset="UTF-8">`,
      `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
      `<meta name="viewport" content="width=device-width, initial-scale=1.0">`,
      `<style>${styles()}</style>`,
      `<title>This File</title>`,
      `</head>`,
      `<body data-key="${escapeHtml(key)}">`,
      this.body(editor),
      `<script nonce="${nonce}">${script()}</script>`,
      `</body>`,
      `</html>`
    ].join("\n");
  }

  dispose(): void {
    if (this.shiftTimer) {
      clearTimeout(this.shiftTimer);
      this.shiftTimer = undefined;
    }
    this.unbind();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

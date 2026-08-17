import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { LiveRanges } from "./live";
import { Comment } from "./model";
import { readPalette } from "./palette";
import { toRelativePath } from "./paths";
import { AnnotationStore } from "./store";
import { formatDate, snippet } from "./thread";

interface Card {
  id: string;
  hex: string | undefined;
  label: string;
  line: number;
  comments: Comment[];
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
    "body { margin: 0; padding: 8px; background: var(--vscode-editor-background);",
    "  color: var(--vscode-foreground); font-family: var(--vscode-font-family);",
    "  font-size: var(--vscode-font-size); }",
    ".empty { color: var(--vscode-descriptionForeground); }",
    ".card { border: 1px solid var(--vscode-panel-border); border-radius: 4px;",
    "  padding: 6px 8px; margin-bottom: 6px; cursor: pointer; }",
    ".card:hover { background: var(--vscode-list-hoverBackground); }",
    ".card:focus-visible { outline: 1px solid var(--vscode-textLink-foreground); }",
    ".head { display: flex; align-items: center; gap: 6px; }",
    ".dot { flex: none; width: 8px; height: 8px; border-radius: 50%;",
    "  background: var(--vscode-descriptionForeground); }",
    ".snippet { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;",
    "  white-space: nowrap; color: var(--vscode-textLink-foreground); }",
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
    card.hex === undefined
      ? `<span class="dot"></span>`
      : `<span class="dot" style="background: ${escapeHtml(card.hex)}"></span>`;
  return [
    `<div class="card" role="button" tabindex="0" data-id="${escapeHtml(card.id)}">`,
    `<div class="head">`,
    dot,
    `<span class="snippet">${escapeHtml(card.label)}</span>`,
    `<span class="line">Line ${card.line}</span>`,
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

  constructor(
    private readonly store: AnnotationStore,
    private readonly live: LiveRanges
  ) {
    this.disposables.push(
      store.onDidChange(() => this.render()),
      vscode.window.onDidChangeActiveTextEditor(() => this.render())
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.unbind();
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    this.bound.push(
      view.webview.onDidReceiveMessage((message: unknown) => this.receive(message)),
      view.onDidChangeVisibility(() => this.render()),
      view.onDidDispose(() => this.unbind())
    );
    this.render();
  }

  private unbind(): void {
    this.view = undefined;
    for (const disposable of this.bound) {
      disposable.dispose();
    }
    this.bound = [];
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
    view.webview.html = this.html(view.webview);
  }

  private cards(): Card[] | undefined {
    const editor = vscode.window.activeTextEditor;
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
      .filter((annotation) => annotation.orphaned !== true && annotation.comments.length > 0);
    const spans = annotations.length > 0 ? this.live.spansFor(document) : undefined;
    return annotations
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
        comments: annotation.comments
      }));
  }

  private body(): string {
    const cards = this.cards();
    if (cards === undefined) {
      return `<p class="empty">Open a file from this workspace to see its comments.</p>`;
    }
    if (cards.length === 0) {
      return `<p class="empty">No comments in this file yet.</p>`;
    }
    return cards.map(renderCard).join("");
  }

  private html(webview: vscode.Webview): string {
    const nonce = createNonce();
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
      `<body>`,
      this.body(),
      `<script nonce="${nonce}">${script()}</script>`,
      `</body>`,
      `</html>`
    ].join("\n");
  }

  dispose(): void {
    this.unbind();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { LiveRanges, SpanMap } from "./live";
import { Comment } from "./model";
import { readPalette } from "./palette";
import { basename } from "./panel";
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

interface CardView {
  id: string;
  html: string;
  line: string;
}

interface Content {
  head: string;
  note: string;
  cards: CardView[];
}

interface Payload extends Content {
  type: "cards";
  key: string;
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
    ".card { border: 1px solid var(--vscode-panel-border);",
    "  background: var(--vscode-editorWidget-background); border-radius: 5px;",
    "  padding: 7px 9px; margin-bottom: 7px; cursor: pointer; }",
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
    "const header = document.getElementById('header');",
    "const list = document.getElementById('list');",
    "const note = document.getElementById('note');",
    "const nodes = new Map();",
    "let shown = '';",
    "let headHtml = '';",
    "let noteHtml = '';",
    "let queued = false;",
    "const build = (html) => {",
    "  const holder = document.createElement('template');",
    "  holder.innerHTML = html;",
    "  return holder.content.firstElementChild;",
    "};",
    "const patch = (cards) => {",
    "  const alive = new Set();",
    "  let index = 0;",
    "  for (const card of cards) {",
    "    alive.add(card.id);",
    "    let entry = nodes.get(card.id);",
    "    if (!entry || entry.html !== card.html) {",
    "      entry = { node: build(card.html), html: card.html, line: null };",
    "      nodes.set(card.id, entry);",
    "    }",
    "    if (entry.line !== card.line) {",
    "      entry.line = card.line;",
    "      const label = entry.node.querySelector('.line');",
    "      if (label) {",
    "        label.textContent = card.line;",
    "      }",
    "    }",
    "    if (list.children[index] !== entry.node) {",
    "      list.insertBefore(entry.node, list.children[index] || null);",
    "    }",
    "    index += 1;",
    "  }",
    "  while (list.children.length > cards.length) {",
    "    list.removeChild(list.lastElementChild);",
    "  }",
    "  for (const id of [...nodes.keys()]) {",
    "    if (!alive.has(id)) {",
    "      nodes.delete(id);",
    "    }",
    "  }",
    "};",
    "const reveal = (target) => {",
    "  const card = target instanceof Element ? target.closest('.card') : null;",
    "  if (!card) {",
    "    return false;",
    "  }",
    "  bridge.postMessage({ type: 'reveal', id: card.dataset.id });",
    "  return true;",
    "};",
    "list.addEventListener('click', (event) => {",
    "  const selection = window.getSelection();",
    "  if (selection && !selection.isCollapsed) {",
    "    return;",
    "  }",
    "  reveal(event.target);",
    "});",
    "list.addEventListener('keydown', (event) => {",
    "  if (event.key !== 'Enter' && event.key !== ' ') {",
    "    return;",
    "  }",
    "  if (reveal(event.target)) {",
    "    event.preventDefault();",
    "  }",
    "});",
    "window.addEventListener('scroll', () => {",
    "  if (queued) {",
    "    return;",
    "  }",
    "  queued = true;",
    "  requestAnimationFrame(() => {",
    "    queued = false;",
    "    bridge.setState({ key: shown, scroll: window.scrollY });",
    "  });",
    "});",
    "window.addEventListener('message', (event) => {",
    "  const data = event.data;",
    "  if (!data || data.type !== 'cards') {",
    "    return;",
    "  }",
    "  if (headHtml !== data.head) {",
    "    headHtml = data.head;",
    "    header.innerHTML = data.head;",
    "  }",
    "  if (noteHtml !== data.note) {",
    "    noteHtml = data.note;",
    "    note.innerHTML = data.note;",
    "  }",
    "  patch(data.cards);",
    "  if (shown !== data.key) {",
    "    shown = data.key;",
    "    const saved = bridge.getState();",
    "    const same = saved && saved.key === shown && typeof saved.scroll === 'number';",
    "    window.scrollTo(0, same ? saved.scroll : 0);",
    "  }",
    "});",
    "bridge.postMessage({ type: 'ready' });"
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
  return [
    `<div class="${classes}" role="button" tabindex="0" data-id="${escapeHtml(card.id)}">`,
    `<div class="head">`,
    dot,
    `<span class="snippet">${escapeHtml(card.label)}</span>`,
    `<span class="line"></span>`,
    `</div>`,
    card.comments.map(renderComment).join(""),
    `</div>`
  ].join("");
}

function lineLabel(card: Card): string {
  return card.orphaned ? "text deleted" : `Line ${card.line}`;
}

export class FileCommentsView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = "codelight.fileComments";

  private readonly disposables: vscode.Disposable[] = [];
  private bound: vscode.Disposable[] = [];
  private view: vscode.WebviewView | undefined;
  private nonce = createNonce();
  private tracked: vscode.TextEditor | undefined;
  private loaded = false;
  private shown: string | undefined;
  private sent: string | undefined;
  private spansKey: string | undefined;
  private spans: SpanMap | undefined;
  private shiftTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly store: AnnotationStore,
    private readonly live: LiveRanges
  ) {
    this.disposables.push(
      store.onDidChange(() => {
        this.forgetSpans();
        this.render();
      }),
      live.onDidShift((document) => {
        this.forgetSpans();
        this.scheduleShift(document);
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.render()),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (this.tracked?.document !== document) {
          return;
        }
        this.tracked = undefined;
        this.forgetSpans();
        this.render();
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => {
        this.forgetSpans();
        this.render();
      }),
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
    view.webview.html = this.shell(view.webview);
  }

  ready(): void {
    this.loaded = true;
    this.render();
  }

  private unbind(): void {
    this.view = undefined;
    this.shown = undefined;
    this.sent = undefined;
    for (const disposable of this.bound) {
      disposable.dispose();
    }
    this.bound = [];
  }

  private forgetSpans(): void {
    this.spansKey = undefined;
    this.spans = undefined;
  }

  private scheduleShift(document: vscode.TextDocument): void {
    if (this.shown !== document.uri.toString()) {
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
    if (payload.type === "ready") {
      this.sent = undefined;
      this.render();
      return;
    }
    if (payload.type !== "reveal" || typeof payload.id !== "string") {
      return;
    }
    void vscode.commands.executeCommand("codelight.revealAnnotation", payload.id);
  }

  private render(): void {
    const view = this.view;
    if (!view || !view.visible) {
      this.shown = undefined;
      return;
    }
    const editor = this.editor();
    const key = editor ? editor.document.uri.toString() : "";
    this.shown = editor ? key : undefined;
    const payload: Payload = { type: "cards", key, ...this.content(editor) };
    const serialized = JSON.stringify(payload);
    if (serialized === this.sent) {
      return;
    }
    this.sent = serialized;
    void view.webview.postMessage(payload);
  }

  private mappable(editor: vscode.TextEditor | undefined): editor is vscode.TextEditor {
    if (!editor || editor.document.isClosed) {
      return false;
    }
    return this.store.relative(editor.document.uri) !== undefined;
  }

  private editor(): vscode.TextEditor | undefined {
    const active = vscode.window.activeTextEditor;
    if (this.mappable(active)) {
      this.tracked = active;
      return active;
    }
    if (this.mappable(this.tracked)) {
      return this.tracked;
    }
    this.tracked = vscode.window.visibleTextEditors.find((candidate) => this.mappable(candidate));
    return this.tracked;
  }

  private spansFor(document: vscode.TextDocument): SpanMap | undefined {
    const key = `${document.uri.toString()}@${document.version}`;
    if (this.spansKey === key) {
      return this.spans;
    }
    this.spans = this.live.spansFor(document);
    this.spansKey = key;
    return this.spans;
  }

  private collect(editor: vscode.TextEditor | undefined): FileCards | undefined {
    const root = editor ? this.store.rootFor(editor.document.uri) : undefined;
    if (!editor || !root) {
      return undefined;
    }
    const document = editor.document;
    const relative = this.store.relative(document.uri) ?? "";
    const palette = readPalette(root);
    const annotations = this.store
      .forFile(document.uri)
      .filter((annotation) => annotation.comments.length > 0);
    const spans = annotations.length > 0 ? this.spansFor(document) : undefined;
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

  private content(editor: vscode.TextEditor | undefined): Content {
    if (!this.loaded) {
      return { head: "", note: "", cards: [] };
    }
    if (!this.store.isReady) {
      return { head: "", note: renderNote("CodeLight needs an open folder."), cards: [] };
    }
    if (this.store.all.length === 0) {
      return {
        head: "",
        note: renderNote("This project has no CodeLight annotations yet."),
        cards: []
      };
    }
    const found = this.collect(editor);
    if (!found) {
      return {
        head: "",
        note: renderNote("Open a file from this workspace to see its comments."),
        cards: []
      };
    }
    const head = renderHeader(found.file);
    if (found.cards.length === 0) {
      return { head, note: renderNote("No comments in this file yet."), cards: [] };
    }
    return {
      head,
      note: "",
      cards: found.cards.map((card) => ({
        id: card.id,
        html: renderCard(card),
        line: lineLabel(card)
      }))
    };
  }

  private shell(webview: vscode.Webview): string {
    const nonce = this.nonce;
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
      `<div id="header"></div>`,
      `<div id="list"></div>`,
      `<div id="note"></div>`,
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

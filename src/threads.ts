import * as vscode from "vscode";
import { buildAnchor } from "./anchors";
import { newId, timestamp } from "./ids";
import { IdentityProvider } from "./identity";
import { LiveRanges } from "./live";
import { Annotation, Comment } from "./model";
import { DEFAULT_PALETTE } from "./palette";
import { toRelativePath, toUri } from "./paths";
import { AnnotationStore } from "./store";

export class ThreadComment implements vscode.Comment {
  savedBody: string;

  constructor(
    readonly annotationId: string,
    readonly commentId: string,
    public body: string | vscode.MarkdownString,
    public mode: vscode.CommentMode,
    public author: vscode.CommentAuthorInformation,
    public contextValue: string,
    public timestamp?: Date
  ) {
    this.savedBody = typeof body === "string" ? body : body.value;
  }
}

function bodyOf(comment: vscode.Comment): string {
  return typeof comment.body === "string" ? comment.body : comment.body.value;
}

function authorInfo(comment: Comment): vscode.CommentAuthorInformation {
  return {
    name: comment.author.login,
    iconPath: vscode.Uri.parse(
      `https://avatars.githubusercontent.com/u/${encodeURIComponent(comment.author.id)}`
    )
  };
}

function parseDate(iso: string): Date | undefined {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export class ThreadView implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly threads = new Map<string, vscode.CommentThread>();
  private readonly owners = new Map<vscode.CommentThread, string>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: AnnotationStore,
    private readonly live: LiveRanges,
    private readonly identity: IdentityProvider
  ) {
    this.controller = vscode.comments.createCommentController("codelight", "CodeLight");
    this.controller.options = {
      prompt: "Comment on this code. Shared with everyone who pulls this repository.",
      placeHolder: "Leave a note for your team"
    };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => {
        const root = this.store.rootUri;
        const relative = root ? toRelativePath(root, document.uri) : undefined;
        if (!relative || document.lineCount === 0) {
          return [];
        }
        return [new vscode.Range(0, 0, document.lineCount - 1, 0)];
      }
    };
    this.disposables.push(
      this.controller,
      store.onDidChange(() => this.sync()),
      identity.onDidChange(() => this.sync()),
      vscode.workspace.onDidOpenTextDocument(() => this.sync()),
      vscode.workspace.onDidCloseTextDocument(() => this.sync()),
      live.onDidShift((document) => this.reposition(document))
    );
    this.sync();
  }

  async reply(reply: vscode.CommentReply): Promise<void> {
    const body = reply.text.trim();
    if (body === "") {
      return;
    }
    const author = await this.identity.require();
    if (!author) {
      return;
    }
    const now = timestamp();
    const comment: Comment = {
      id: newId(),
      author: { login: author.login, id: author.id },
      body,
      createdAt: now,
      updatedAt: now
    };
    const owned = this.owners.get(reply.thread);
    const annotationId = owned ?? (await this.createAnnotation(reply.thread, comment));
    if (annotationId === undefined) {
      return;
    }
    if (owned !== undefined) {
      const saved = await this.store.update(annotationId, (current) => ({
        ...current,
        updatedAt: now,
        comments: [...current.comments, comment]
      }));
      if (!saved) {
        await vscode.env.clipboard.writeText(body).then(undefined, () => undefined);
        void vscode.window.showWarningMessage(
          "CodeLight could not save the comment. It was copied to the clipboard."
        );
        return;
      }
    }
    reply.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.sync();
  }

  edit(comment: ThreadComment): void {
    const thread = this.threads.get(comment.annotationId);
    if (!thread) {
      return;
    }
    thread.comments = thread.comments.map((entry) => {
      if (entry instanceof ThreadComment && entry.commentId === comment.commentId) {
        entry.mode = vscode.CommentMode.Editing;
      }
      return entry;
    });
  }

  cancelEdit(comment: ThreadComment): void {
    const thread = this.threads.get(comment.annotationId);
    if (!thread) {
      return;
    }
    thread.comments = thread.comments.map((entry) => {
      if (entry instanceof ThreadComment && entry.commentId === comment.commentId) {
        entry.body = entry.savedBody;
        entry.mode = vscode.CommentMode.Preview;
      }
      return entry;
    });
  }

  async saveEdit(comment: ThreadComment): Promise<void> {
    const thread = this.threads.get(comment.annotationId);
    if (!thread) {
      return;
    }
    const edited = thread.comments.find(
      (entry) => entry instanceof ThreadComment && entry.commentId === comment.commentId
    );
    const body = edited ? bodyOf(edited).trim() : "";
    if (body === "") {
      this.cancelEdit(comment);
      return;
    }
    const now = timestamp();
    const saved = await this.store.update(comment.annotationId, (current) => ({
      ...current,
      updatedAt: now,
      comments: current.comments.map((entry) =>
        entry.id === comment.commentId ? { ...entry, body, updatedAt: now } : entry
      )
    }));
    if (!saved) {
      void vscode.window.showWarningMessage("CodeLight could not save the comment.");
    }
    this.sync();
  }

  async deleteComment(comment: ThreadComment): Promise<void> {
    const annotation = this.store.byId(comment.annotationId);
    if (!annotation) {
      return;
    }
    const last = annotation.comments.length <= 1;
    const confirmed = await vscode.window.showWarningMessage(
      last ? "Delete this comment and keep the highlight?" : "Delete this comment?",
      { modal: true },
      "Delete"
    );
    if (confirmed !== "Delete") {
      return;
    }
    const saved = await this.store.update(comment.annotationId, (current) => ({
      ...current,
      updatedAt: timestamp(),
      comments: current.comments.filter((entry) => entry.id !== comment.commentId)
    }));
    if (!saved) {
      void vscode.window.showWarningMessage("CodeLight could not delete the comment.");
    }
    this.sync();
  }

  async open(annotationId: string): Promise<void> {
    const annotation = this.store.byId(annotationId);
    const root = this.store.rootUri;
    if (!annotation || !root) {
      return;
    }
    const uri = toUri(root, annotation.file);
    if (!uri) {
      return;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preserveFocus: false });
    this.sync();
    const thread = this.threads.get(annotationId) ?? this.attach(document, annotation);
    if (!thread) {
      return;
    }
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    await vscode.commands.executeCommand("workbench.action.focusCommentOnCurrentLine");
  }

  private async createAnnotation(
    thread: vscode.CommentThread,
    comment: Comment
  ): Promise<string | undefined> {
    const root = this.store.rootUri;
    const relative = root ? toRelativePath(root, thread.uri) : undefined;
    if (!relative) {
      void vscode.window.showWarningMessage(
        "CodeLight only tracks files inside the workspace folder."
      );
      return undefined;
    }
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(thread.uri);
    } catch {
      return undefined;
    }
    const anchorLine = thread.range ? thread.range.start.line : 0;
    const line = document.lineAt(Math.min(anchorLine, document.lineCount - 1));
    const range = line.range.isEmpty ? line.rangeIncludingLineBreak : line.range;
    const text = document.getText();
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
      anchor: buildAnchor(text, document.offsetAt(range.start), document.offsetAt(range.end)),
      color: DEFAULT_PALETTE[0].id,
      author: comment.author,
      createdAt: now,
      updatedAt: now,
      comments: [comment]
    };
    if (!(await this.store.add(annotation))) {
      void vscode.window.showWarningMessage("CodeLight could not save the comment.");
      return undefined;
    }
    thread.dispose();
    return annotation.id;
  }

  private attach(
    document: vscode.TextDocument,
    annotation: Annotation
  ): vscode.CommentThread | undefined {
    const range = this.live.rangeFor(document, annotation);
    const thread = this.controller.createCommentThread(document.uri, range, []);
    thread.label = `CodeLight, highlighted by ${annotation.author.login}`;
    thread.contextValue = "codelight";
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    this.threads.set(annotation.id, thread);
    this.owners.set(thread, annotation.id);
    this.fill(thread, annotation);
    return thread;
  }

  private fill(thread: vscode.CommentThread, annotation: Annotation): void {
    const me = this.identity.identity?.id;
    thread.comments = annotation.comments.map((comment) => {
      const body = new vscode.MarkdownString(comment.body);
      return new ThreadComment(
        annotation.id,
        comment.id,
        body,
        vscode.CommentMode.Preview,
        authorInfo(comment),
        comment.author.id === me ? "mine" : "theirs",
        parseDate(comment.createdAt)
      );
    });
  }

  private sync(): void {
    const root = this.store.rootUri;
    const wanted = new Map<string, { annotation: Annotation; document: vscode.TextDocument }>();
    if (root) {
      for (const document of vscode.workspace.textDocuments) {
        const relative = toRelativePath(root, document.uri);
        if (!relative) {
          continue;
        }
        for (const annotation of this.store.forFile(relative)) {
          if (annotation.comments.length > 0 && annotation.orphaned !== true) {
            wanted.set(annotation.id, { annotation, document });
          }
        }
      }
    }
    for (const [id, thread] of this.threads) {
      if (!wanted.has(id)) {
        this.owners.delete(thread);
        thread.dispose();
        this.threads.delete(id);
      }
    }
    for (const [id, entry] of wanted) {
      const existing = this.threads.get(id);
      if (!existing) {
        this.attach(entry.document, entry.annotation);
        continue;
      }
      existing.range = this.live.rangeFor(entry.document, entry.annotation);
      this.fill(existing, entry.annotation);
    }
  }

  private reposition(document: vscode.TextDocument): void {
    const root = this.store.rootUri;
    const relative = root ? toRelativePath(root, document.uri) : undefined;
    if (!relative) {
      return;
    }
    const spans = this.live.spansFor(document);
    for (const annotation of this.store.forFile(relative)) {
      const thread = this.threads.get(annotation.id);
      if (thread) {
        thread.range = this.live.rangeFor(document, annotation, spans);
      }
    }
  }

  dispose(): void {
    for (const thread of this.threads.values()) {
      thread.dispose();
    }
    this.threads.clear();
    this.owners.clear();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

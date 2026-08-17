import * as vscode from "vscode";
import { buildAnchor, findAnchor } from "./anchors";
import { newId, timestamp } from "./ids";
import { IdentityProvider } from "./identity";
import { LiveRanges } from "./live";
import { Anchor, Annotation, Comment, MAX_COMMENT_BODY } from "./model";
import { readGutterMode, readPalette } from "./palette";
import { rescue, withRescue } from "./rescue";
import { toRelativePath, toUri } from "./paths";
import { AnnotationStore } from "./store";
import { Visibility } from "./visibility";

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
  private readonly drafts = new Set<string>();
  private readonly pending = new Map<vscode.CommentThread, { anchor: Anchor; version: number; length: number }>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: AnnotationStore,
    private readonly live: LiveRanges,
    private readonly identity: IdentityProvider,
    private readonly visibility: Visibility
  ) {
    this.controller = vscode.comments.createCommentController("codelight", "CodeLight");
    this.controller.options = {
      prompt: "Comment on this code. Shared with everyone who pulls this repository.",
      placeHolder: "Leave a note for your team"
    };
    this.controller.commentingRangeProvider = this.rangeProvider();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("codelight.commentGutter")) {
          this.controller.commentingRangeProvider = this.rangeProvider();
        }
      })
    );
    this.disposables.push(
      store.onDidChange(() => {
        this.controller.commentingRangeProvider = this.rangeProvider();
      })
    );
    this.disposables.push(
      visibility.onDidChange((shown) => {
        this.controller.commentingRangeProvider = this.rangeProvider();
        this.sync();
        if (!shown && this.pending.size > 0) {
          void vscode.window.showInformationMessage("The note you are writing stays open.");
        }
      })
    );
    this.wire();
  }

  private rangeProvider(): vscode.CommentingRangeProvider {
    return {
      provideCommentingRanges: (document) => {
        const root = this.store.rootUri;
        const relative = root ? toRelativePath(root, document.uri) : undefined;
        if (!relative || document.lineCount === 0) {
          return [];
        }
        const mode = readGutterMode(document.uri);
        if (mode === "off" || !this.visibility.visible) {
          return [];
        }
        if (mode === "always") {
          return [new vscode.Range(0, 0, document.lineCount - 1, 0)];
        }
        const spans = this.live.spansFor(document);
        const lines = new Set<number>();
        for (const annotation of this.store.forFile(relative)) {
          if (annotation.orphaned === true) {
            continue;
          }
          const range = this.live.rangeFor(document, annotation, spans);
          for (let line = range.start.line; line <= range.end.line; line += 1) {
            lines.add(line);
          }
        }
        return [...lines].sort((a, b) => a - b).map((line) => new vscode.Range(line, 0, line, 0));
      }
    };
  }

  private wire(): void {
    this.disposables.push(
      this.controller,
      this.store.onDidChange(() => this.sync()),
      this.identity.onDidChange(() => this.sync()),
      vscode.workspace.onDidOpenTextDocument(() => this.sync()),
      vscode.workspace.onDidCloseTextDocument((document) => {
        for (const thread of [...this.pending.keys()]) {
          if (thread.uri.toString() === document.uri.toString()) {
            this.pending.delete(thread);
            thread.dispose();
          }
        }
        this.sync();
      }),
      this.live.onDidShift((document) => this.reposition(document))
    );
    this.sync();
  }

  async reply(reply: vscode.CommentReply): Promise<void> {
    const owned = this.owners.get(reply.thread);
    const body = reply.text.trim();
    if (body === "") {
      return;
    }
    if (body.length > MAX_COMMENT_BODY) {
      const rescued = await rescue(body);
      void vscode.window.showWarningMessage(
        withRescue(
          `Keep comments under ${MAX_COMMENT_BODY} characters. This one is ${body.length}.`,
          rescued
        )
      );
      return;
    }
    const author = await this.identity.require();
    if (!author) {
      const rescued = await rescue(body);
      if (rescued) {
        void vscode.window.showInformationMessage(
          "Your comment was copied to the clipboard. Sign in and paste it back."
        );
      }
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
    const adopted = owned ?? this.annotationAt(reply.thread);
    if (adopted !== undefined) {
      const annotation = this.store.byId(adopted);
      const document = vscode.workspace.textDocuments.find(
        (entry) => entry.uri.toString() === reply.thread.uri.toString()
      );
      const collapsed =
        annotation !== undefined &&
        document !== undefined &&
        this.live.rangeFor(document, annotation).isEmpty;
      if (annotation?.orphaned === true || collapsed) {
        const rescued = await rescue(body);
        void vscode.window.showWarningMessage(
          withRescue("That highlight lost its text, so the comment was not saved.", rescued)
        );
        return;
      }
    }
    const annotationId =
      adopted ?? (await this.createAnnotation(reply.thread, comment, comment.author));
    if (annotationId === undefined) {
      return;
    }
    if (owned === undefined && adopted === undefined) {
      this.drafts.delete(annotationId);
      const created = this.threads.get(annotationId);
      if (created) {
        created.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      }
      return;
    }
    {
      let ran = false;
      let found = false;
      let lost = false;
      const saved = await this.store.transaction((annotations) => {
        ran = true;
        const current = annotations.get(annotationId);
        if (!current) {
          return false;
        }
        if (current.orphaned === true) {
          lost = true;
          return false;
        }
        found = true;
        annotations.set(annotationId, {
          ...current,
          updatedAt: now,
          comments: [...current.comments, comment]
        });
        return true;
      });
      if (!saved) {
        const rescued = await rescue(body);
        const reason = !ran
          ? "CodeLight could not update the shared file."
          : lost
            ? "That highlight lost its text, so the comment was not saved."
            : found
              ? "CodeLight could not save the comment."
              : "That highlight is no longer in the shared file.";
        if (ran && !found) {
          await this.store.refresh();
        }
        void vscode.window.showWarningMessage(withRescue(reason, rescued));
        return;
      }
    }
    this.drafts.delete(annotationId);
    reply.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.sync();
  }

  private async rescueLostEdit(entry: ThreadComment): Promise<void> {
    const body = typeof entry.body === "string" ? entry.body : entry.body.value;
    if (body.trim() === "" || body === entry.savedBody) {
      return;
    }
    const rescued = await rescue(body);
    void vscode.window.showWarningMessage(
      withRescue("The comment you were editing was removed from the shared file.", rescued)
    );
  }

  private closePending(): void {
    for (const thread of this.pending.keys()) {
      thread.dispose();
    }
    this.pending.clear();
  }

  async discard(target?: vscode.CommentReply | vscode.CommentThread): Promise<void> {
    const thread =
      target && "thread" in target
        ? (target as vscode.CommentReply).thread
        : (target as vscode.CommentThread | undefined);
    const typed = target && "text" in target ? (target as vscode.CommentReply).text.trim() : "";
    if (typed !== "" && (await rescue(typed))) {
      void vscode.window.showInformationMessage("Your text was copied to the clipboard.");
    }
    if (!thread) {
      this.closePending();
      return;
    }
    if (this.pending.has(thread)) {
      this.pending.delete(thread);
      thread.dispose();
      return;
    }
    const owned = this.owners.get(thread);
    if (owned === undefined) {
      thread.dispose();
      return;
    }
    if (thread.comments.length === 0) {
      this.drafts.delete(owned);
      this.owners.delete(thread);
      this.threads.delete(owned);
      thread.dispose();
      return;
    }
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
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
    if (body.length > MAX_COMMENT_BODY) {
      void vscode.window.showWarningMessage(
        `Keep comments under ${MAX_COMMENT_BODY} characters. This one is ${body.length}.`
      );
      return;
    }
    const now = timestamp();
    let ran = false;
    let found = false;
    const saved = await this.store.transaction((annotations) => {
      ran = true;
      const current = annotations.get(comment.annotationId);
      if (!current || !current.comments.some((entry) => entry.id === comment.commentId)) {
        return false;
      }
      found = true;
      annotations.set(comment.annotationId, {
        ...current,
        updatedAt: now,
        comments: current.comments.map((entry) =>
          entry.id === comment.commentId ? { ...entry, body, updatedAt: now } : entry
        )
      });
      return true;
    });
    if (!saved) {
      const rescued = await rescue(body);
      const reason = !ran
        ? "CodeLight could not update the shared file."
        : found
          ? "CodeLight could not save the comment."
          : "That comment is no longer in the shared file.";
      if (ran && !found) {
        await this.store.refresh();
      }
      void vscode.window.showWarningMessage(withRescue(reason, rescued));
      return;
    }
    if (edited instanceof ThreadComment) {
      edited.savedBody = body;
      edited.mode = vscode.CommentMode.Preview;
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
    let ran = false;
    let found = false;
    const saved = await this.store.transaction((annotations) => {
      ran = true;
      const current = annotations.get(comment.annotationId);
      if (!current || !current.comments.some((entry) => entry.id === comment.commentId)) {
        return false;
      }
      found = true;
      annotations.set(comment.annotationId, {
        ...current,
        updatedAt: timestamp(),
        comments: current.comments.filter((entry) => entry.id !== comment.commentId)
      });
      return true;
    });
    if (!saved) {
      void vscode.window.showWarningMessage(
        !ran
          ? "CodeLight could not update the shared file."
          : found
            ? "CodeLight could not delete the comment."
            : "That comment is no longer in the shared file."
      );
      if (ran && !found) {
        await this.store.refresh();
      }
    }
    this.sync();
  }

  async openDraft(editor: vscode.TextEditor): Promise<void> {
    const root = this.store.rootUri;
    const relative = root ? toRelativePath(root, editor.document.uri) : undefined;
    if (!relative) {
      void vscode.window.showWarningMessage(
        "CodeLight only tracks files inside the workspace folder."
      );
      return;
    }
    const candidates: vscode.Range[] = [];
    for (const selection of editor.selections) {
      const candidate = selection.isEmpty
        ? editor.document.lineAt(selection.active.line).range
        : new vscode.Range(selection.start, selection.end);
      if (!candidate.isEmpty) {
        candidates.push(candidate);
      }
    }
    const range = candidates[0];
    if (!range) {
      void vscode.window.showWarningMessage(
        "This line is empty. Select some text to comment on."
      );
      return;
    }
    if (candidates.length > 1) {
      void vscode.window.showInformationMessage(
        "CodeLight comments on one selection at a time. Using the first one."
      );
    }
    for (const open of this.pending.keys()) {
      if (
        open.uri.toString() === editor.document.uri.toString() &&
        open.range !== undefined &&
        !open.range.intersection(range)?.isEmpty
      ) {
        open.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        editor.selection = new vscode.Selection(range.end, range.end);
        await vscode.commands.executeCommand("workbench.action.focusCommentOnCurrentLine");
        return;
      }
    }
    const text = editor.document.getText();
    const thread = this.controller.createCommentThread(editor.document.uri, range, []);
    thread.label = "New CodeLight note";
    thread.contextValue = "draft";
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.pending.set(thread, {
      anchor: buildAnchor(
        text,
        editor.document.offsetAt(range.start),
        editor.document.offsetAt(range.end)
      ),
      version: editor.document.version,
      length: editor.document.offsetAt(range.end) - editor.document.offsetAt(range.start)
    });
    editor.selection = new vscode.Selection(range.end, range.end);
    await vscode.commands.executeCommand("workbench.action.focusCommentOnCurrentLine");
  }

  async open(annotationId: string): Promise<void> {
    const annotation = this.store.byId(annotationId);
    const root = this.store.rootUri;
    if (!annotation) {
      void vscode.window.showWarningMessage("That highlight is no longer in the shared file.");
      return;
    }
    if (!root) {
      return;
    }
    if (annotation.orphaned === true) {
      void vscode.window.showWarningMessage(
        "That highlight lost its text. Remove it instead of commenting on it."
      );
      return;
    }
    const uri = toUri(root, annotation.file);
    if (!uri) {
      return;
    }
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch {
      void vscode.window.showWarningMessage(`CodeLight could not open ${annotation.file}.`);
      return;
    }
    let editor: vscode.TextEditor;
    try {
      editor = await vscode.window.showTextDocument(document, { preserveFocus: false });
    } catch {
      void vscode.window.showWarningMessage(`CodeLight could not open ${annotation.file}.`);
      return;
    }
    if (this.live.rangeFor(document, annotation).isEmpty) {
      void vscode.window.showWarningMessage(
        "That highlight lost its text. Remove it instead of commenting on it."
      );
      return;
    }
    if (annotation.comments.length === 0) {
      this.drafts.add(annotationId);
    }
    this.sync();
    const thread = this.threads.get(annotationId);
    if (!thread) {
      void vscode.window.showWarningMessage("CodeLight could not open that thread.");
      return;
    }
    const range = this.live.rangeFor(document, annotation);
    editor.selection = new vscode.Selection(range.end, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    await vscode.commands.executeCommand("workbench.action.focusCommentOnCurrentLine");
  }

  async highlightOnly(target?: vscode.CommentReply | vscode.CommentThread): Promise<void> {
    const thread =
      target && "thread" in target ? (target as vscode.CommentReply).thread : (target as vscode.CommentThread | undefined);
    const typed = target && "text" in target ? (target as vscode.CommentReply).text.trim() : "";
    if (!thread || !this.pending.has(thread)) {
      return;
    }
    const author = await this.identity.require();
    if (!author) {
      if (typed !== "" && (await rescue(typed))) {
        void vscode.window.showInformationMessage(
          "Your text was copied to the clipboard."
        );
      }
      return;
    }
    const created = await this.createAnnotation(thread, undefined, {
      login: author.login,
      id: author.id
    });
    if (typed === "") {
      return;
    }
    const rescued = await rescue(typed);
    if (!rescued) {
      return;
    }
    if (created === undefined) {
      void vscode.window.showInformationMessage(
        "The highlight was not saved. Your text was copied to the clipboard."
      );
      return;
    }
    void vscode.window.showInformationMessage(
      "Saved the highlight without the comment. Your text was copied to the clipboard."
    );
  }

  async deleteHighlight(thread?: vscode.CommentThread): Promise<void> {
    if (!thread) {
      return;
    }
    const id = this.owners.get(thread);
    if (id === undefined) {
      return;
    }
    const annotation = this.store.byId(id);
    if (!annotation) {
      return;
    }
    const count = annotation.comments.length;
    if (count > 0) {
      const confirmed = await vscode.window.showWarningMessage(
        `Remove this highlight and its ${count} comment${count === 1 ? "" : "s"}?`,
        { modal: true },
        "Remove"
      );
      if (confirmed !== "Remove") {
        return;
      }
    }
    let ran = false;
    let found = false;
    let drifted = false;
    const saved = await this.store.transaction((annotations) => {
      ran = true;
      const current = annotations.get(id);
      if (!current) {
        return false;
      }
      if (current.comments.length !== count) {
        drifted = true;
        return false;
      }
      found = true;
      annotations.delete(id);
      return true;
    });
    if (drifted) {
      await this.store.refresh();
      void vscode.window.showWarningMessage(
        "The comments on that highlight just changed. Try Delete Highlight again to confirm."
      );
      return;
    }
    if (!saved) {
      if (ran && !found) {
        await this.store.refresh();
      }
      void vscode.window.showWarningMessage(
        ran && !found
          ? "That highlight is no longer in the shared file."
          : "CodeLight could not update the shared file."
      );
      return;
    }
    this.drafts.delete(id);
  }

  private annotationAt(thread: vscode.CommentThread): string | undefined {
    const root = this.store.rootUri;
    const relative = root ? toRelativePath(root, thread.uri) : undefined;
    const range = thread.range;
    if (!relative || !range) {
      return undefined;
    }
    const document = vscode.workspace.textDocuments.find(
      (entry) => entry.uri.toString() === thread.uri.toString()
    );
    if (!document) {
      return undefined;
    }
    const spans = this.live.spansFor(document);
    for (const annotation of this.store.forFile(relative)) {
      if (annotation.orphaned === true) {
        continue;
      }
      const live = this.live.rangeFor(document, annotation, spans);
      if (!live.isEmpty && live.start.line <= range.start.line && range.start.line <= live.end.line) {
        return annotation.id;
      }
    }
    return undefined;
  }

  private async createAnnotation(
    thread: vscode.CommentThread,
    comment: Comment | undefined,
    author: Comment["author"]
  ): Promise<string | undefined> {
    const root = this.store.rootUri;
    const relative = root ? toRelativePath(root, thread.uri) : undefined;
    if (!relative) {
      const rescued = comment ? await rescue(comment.body) : false;
      void vscode.window.showWarningMessage(
        withRescue("CodeLight only tracks files inside the workspace folder.", rescued)
      );
      return undefined;
    }
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(thread.uri);
    } catch {
      const rescued = comment ? await rescue(comment.body) : false;
      void vscode.window.showWarningMessage(
        withRescue("CodeLight could not open that file, so nothing was saved.", rescued)
      );
      return undefined;
    }
    const draft = this.pending.get(thread);
    const requested = thread.range;
    let range: vscode.Range;
    if (draft && document.version !== draft.version) {
      const settled = requested ? document.validateRange(requested) : undefined;
      const unmoved =
        settled !== undefined &&
        !settled.isEmpty &&
        document.getText(settled).startsWith(draft.anchor.text);
      const found = unmoved ? undefined : findAnchor(document.getText(), draft.anchor);
      if (unmoved && settled) {
        range = settled;
      } else if (found) {
        const width = Math.max(found.end - found.start, draft.length);
        const end = Math.min(document.getText().length, found.start + width);
        range = new vscode.Range(document.positionAt(found.start), document.positionAt(end));
      } else {
        const rescued = comment ? await rescue(comment.body) : false;
        void vscode.window.showWarningMessage(
          withRescue("The file changed and the selection could not be found again.", rescued)
        );
        return undefined;
      }
    } else if (requested && !requested.isEmpty) {
      range = document.validateRange(requested);
    } else {
      const anchorLine = requested ? requested.start.line : 0;
      const line = document.lineAt(Math.min(anchorLine, document.lineCount - 1));
      range = line.range.isEmpty ? line.rangeIncludingLineBreak : line.range;
    }
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
      color: readPalette(root)[0].id,
      author,
      createdAt: now,
      updatedAt: now,
      comments: comment ? [comment] : []
    };
    if (!(await this.store.add(annotation))) {
      const rescued = comment ? await rescue(comment.body) : false;
      void vscode.window.showWarningMessage(
        withRescue(
          comment ? "CodeLight could not save the comment." : "CodeLight could not save the highlight.",
          rescued
        )
      );
      return undefined;
    }
    this.pending.delete(thread);
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
    thread.contextValue = "saved";
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    this.threads.set(annotation.id, thread);
    this.owners.set(thread, annotation.id);
    this.fill(thread, annotation);
    return thread;
  }

  private fill(thread: vscode.CommentThread, annotation: Annotation): void {
    const me = this.identity.identity?.id;
    const editing = new Map<string, ThreadComment>();
    for (const entry of thread.comments) {
      if (entry instanceof ThreadComment && entry.mode === vscode.CommentMode.Editing) {
        editing.set(entry.commentId, entry);
      }
    }
    for (const [id, entry] of editing) {
      if (!annotation.comments.some((comment) => comment.id === id)) {
        void this.rescueLostEdit(entry);
      }
    }
    thread.comments = annotation.comments.map((comment) => {
      const open = editing.get(comment.id);
      if (open) {
        return open;
      }
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
    if (root && this.visibility.visible) {
      for (const document of vscode.workspace.textDocuments) {
        const relative = toRelativePath(root, document.uri);
        if (!relative) {
          continue;
        }
        for (const annotation of this.store.forFile(relative)) {
          if (annotation.orphaned === true) {
            continue;
          }
          if (annotation.comments.length > 0 || this.drafts.has(annotation.id)) {
            wanted.set(annotation.id, { annotation, document });
          }
        }
      }
    }
    const hidden = !this.visibility.visible;
    for (const [id, thread] of this.threads) {
      if (!wanted.has(id)) {
        const gone = this.store.byId(id) === undefined;
        if (gone) {
          for (const entry of thread.comments) {
            if (entry instanceof ThreadComment && entry.mode === vscode.CommentMode.Editing) {
              void this.rescueLostEdit(entry);
            }
          }
        }
        this.owners.delete(thread);
        if (!hidden) {
          this.drafts.delete(id);
        }
        thread.dispose();
        this.threads.delete(id);
      }
    }
    for (const id of [...this.drafts]) {
      const annotation = this.store.byId(id);
      if (!annotation || annotation.comments.length > 0 || annotation.orphaned === true) {
        this.drafts.delete(id);
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
    this.closePending();
    this.threads.clear();
    this.owners.clear();
    this.drafts.clear();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

import * as vscode from "vscode";
import { buildAnchor, findAnchor } from "./anchors";
import { newId, timestamp } from "./ids";
import { Identity, IdentityProvider } from "./identity";
import { SharingState } from "./sharing";
import { LiveRanges } from "./live";
import { Anchor, Annotation, Comment, MAX_COMMENT_BODY } from "./model";
import { readGutterMode, readPalette } from "./palette";
import { rescue, withRescue } from "./rescue";
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
  if (comment.author.id.startsWith("local:") || !/^\d+$/.test(comment.author.id)) {
    return { name: comment.author.login };
  }
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
  private readonly lost: string[] = [];
  private lostTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pending = new Map<vscode.CommentThread, { anchor: Anchor; version: number; length: number }>();
  private readonly disposables: vscode.Disposable[] = [];
  private askedToSignIn = false;

  constructor(
    private readonly store: AnnotationStore,
    private readonly live: LiveRanges,
    private readonly identity: IdentityProvider,
    private readonly visibility: Visibility,
    private readonly sharing = new SharingState()
  ) {
    this.controller = vscode.comments.createCommentController("codelight", "CodeLight");
    this.controller.options = {
      prompt: "A note beside the code. It travels with the annotation file if you commit it.",
      placeHolder: "Write a note"
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
        const scoped = vscode.window.visibleTextEditors.some(
          (editor) => readGutterMode(editor.document.uri) === "highlights"
        );
        if (scoped || readGutterMode(undefined) === "highlights") {
          this.controller.commentingRangeProvider = this.rangeProvider();
        }
      })
    );
    this.disposables.push(
      visibility.onDidChange(() => {
        this.controller.commentingRangeProvider = this.rangeProvider();
        this.sync();
      })
    );
    this.wire();
  }

  private rangeProvider(): vscode.CommentingRangeProvider {
    return {
      provideCommentingRanges: (document) => {
        if (this.store.relative(document.uri) === undefined || document.lineCount === 0) {
          return [];
        }
        const mode = readGutterMode(document.uri);
        if (mode === "off" || !this.visibility.visible) {
          return [];
        }
        if (mode === "always") {
          let last = document.lineCount - 1;
          while (last > 0 && document.lineAt(last).range.isEmpty) {
            last -= 1;
          }
          return document.lineAt(last).range.isEmpty ? [] : [new vscode.Range(0, 0, last, 0)];
        }
        const placed = this.live.placedIn(document);
        const spans = placed.spans;
        const lines = new Set<number>();
        for (const annotation of this.store.forFile(document.uri)) {
          if (annotation.orphaned === true || placed.detached.has(annotation.id)) {
            continue;
          }
          const range = this.live.rangeFor(document, annotation, spans);
          if (range.isEmpty) {
            continue;
          }
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
    this.visibility.show();
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
    void this.suggestSignIn(reply.thread.uri, author);
    const now = timestamp();
    const comment: Comment = {
      id: newId(),
      author: { login: author.login, id: author.id },
      body,
      createdAt: now,
      updatedAt: now
    };
    if (owned !== undefined) {
      const annotation = this.store.byId(owned);
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
      owned ?? (await this.createAnnotation(reply.thread, comment, comment.author));
    if (annotationId === undefined) {
      return;
    }
    if (owned === undefined) {
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
      const scope = this.store.byId(annotationId)?.root ?? reply.thread.uri;
      const saved = await this.store.transaction(scope, (annotations) => {
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
          ? "CodeLight could not update the annotation file."
          : lost
            ? "That highlight lost its text, so the comment was not saved."
            : found
              ? "CodeLight could not save the comment."
              : "That highlight is no longer in the annotation file.";
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

  private async suggestSignIn(target: vscode.Uri, author: Identity): Promise<void> {
    if (author.verified || this.askedToSignIn) {
      return;
    }
    const store = this.store.storeAt(target)?.location;
    const state = store ? await this.sharing.of(store) : "unknown";
    if (state !== "tracked" && state !== "untracked") {
      return;
    }
    this.askedToSignIn = true;
    const committed =
      state === "tracked"
        ? "These notes are committed, so your colleagues will see them"
        : "This annotation file is not committed yet, and once it is your colleagues will see these notes";
    void vscode.window
      .showInformationMessage(
        `${committed} signed ${author.login}, the name git knows you by. Sign in with GitHub to use your account instead.`,
        "Sign in with GitHub"
      )
      .then((chosen) => {
        if (chosen === "Sign in with GitHub") {
          void vscode.commands.executeCommand("codelight.signIn");
        }
      });
  }

  private collectLostEdit(entry: ThreadComment): void {
    const body = typeof entry.body === "string" ? entry.body : entry.body.value;
    if (body.trim() === "" || body === entry.savedBody) {
      return;
    }
    this.lost.push(body);
    if (this.lostTimer) {
      return;
    }
    this.lostTimer = setTimeout(() => {
      this.lostTimer = undefined;
      void this.reportLostEdits();
    }, 0);
  }

  private async reportLostEdits(): Promise<void> {
    const pending = this.lost.splice(0, this.lost.length);
    if (pending.length === 0) {
      return;
    }
    const rescued = await rescue(pending.join("\n\n"));
    const many = pending.length > 1;
    const what = many
      ? `${pending.length} comments you were editing were closed before they were saved.`
      : "A comment you were editing was closed before it was saved.";
    void vscode.window.showWarningMessage(withRescue(what, rescued, many));
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
    const scope = this.store.byId(comment.annotationId)?.root ?? thread.uri;
    const saved = await this.store.transaction(scope, (annotations) => {
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
        ? "CodeLight could not update the annotation file."
        : found
          ? "CodeLight could not save the comment."
          : "That comment is no longer in the annotation file.";
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
    const thread = this.threads.get(comment.annotationId);
    if (!annotation) {
      void vscode.window.showWarningMessage("That highlight is no longer in the annotation file.");
      await this.store.refresh();
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
    const scope = annotation.root ?? thread?.uri;
    const saved = await this.store.transaction(scope, (annotations) => {
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
          ? "CodeLight could not update the annotation file."
          : found
            ? "CodeLight could not delete the comment."
            : "That comment is no longer in the annotation file."
      );
      if (ran && !found) {
        await this.store.refresh();
      }
    }
    this.sync();
  }

  async openDraft(editor: vscode.TextEditor): Promise<void> {
    if (this.store.relative(editor.document.uri) === undefined) {
      void vscode.window.showWarningMessage(
        "CodeLight only tracks files inside a folder of this workspace."
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
    this.visibility.show();
    for (const open of this.pending.keys()) {
      const overlap =
        open.uri.toString() === editor.document.uri.toString() && open.range !== undefined
          ? open.range.intersection(range)
          : undefined;
      if (overlap !== undefined && !overlap.isEmpty) {
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
    if (!annotation) {
      void vscode.window.showWarningMessage("That highlight is no longer in the annotation file.");
      return;
    }
    if (annotation.orphaned === true) {
      void vscode.window.showWarningMessage(
        "That highlight lost its text. Remove it instead of commenting on it."
      );
      return;
    }
    this.visibility.show();
    const uri = this.store.uriFor(annotation);
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
    if (this.live.detachedIn(document).has(annotationId)) {
      void vscode.window.showWarningMessage(
        "CodeLight cannot find the text that highlight marks in this version of the file, so it will not guess where to put the thread."
      );
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
      this.drafts.delete(annotationId);
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
    const created = await this.createAnnotation(thread, undefined, {
      login: author.login,
      id: author.id
    });
    if (typed === "") {
      return;
    }
    const rescued = await rescue(typed);
    const kept = rescued ? " Your text was copied to the clipboard." : "";
    void vscode.window.showInformationMessage(
      created === undefined
        ? `The highlight was not saved.${kept}`
        : `Saved the highlight without the comment.${kept}`
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
    const scope = annotation.root ?? thread.uri;
    const saved = await this.store.transaction(scope, (annotations) => {
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
          ? "That highlight is no longer in the annotation file."
          : "CodeLight could not update the annotation file."
      );
      return;
    }
    this.drafts.delete(id);
  }

  private async createAnnotation(
    thread: vscode.CommentThread,
    comment: Comment | undefined,
    author: Comment["author"]
  ): Promise<string | undefined> {
    const relative = this.store.relative(thread.uri);
    const root = this.store.rootFor(thread.uri);
    if (relative === undefined || root === undefined) {
      const rescued = comment ? await rescue(comment.body) : false;
      void vscode.window.showWarningMessage(
        withRescue("CodeLight only tracks files inside a folder of this workspace.", rescued)
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
    if (range.isEmpty) {
      const rescued = comment ? await rescue(comment.body) : false;
      void vscode.window.showWarningMessage(
        withRescue("That line is empty. Select some text to comment on.", rescued)
      );
      return undefined;
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
      comments: comment ? [comment] : [],
      root: root.toString()
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
    const mine = (author: { id: string }) => this.identity.owns(author as never);
    const editing = new Map<string, ThreadComment>();
    for (const entry of thread.comments) {
      if (entry instanceof ThreadComment && entry.mode === vscode.CommentMode.Editing) {
        editing.set(entry.commentId, entry);
      }
    }
    for (const [id, entry] of editing) {
      if (!annotation.comments.some((comment) => comment.id === id)) {
        this.collectLostEdit(entry);
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
        mine(comment.author) ? "mine" : "theirs",
        parseDate(comment.createdAt)
      );
    });
  }

  private sync(): void {
    const wanted = new Map<string, { annotation: Annotation; document: vscode.TextDocument }>();
    if (this.visibility.visible) {
      for (const document of vscode.workspace.textDocuments) {
        if (this.store.relative(document.uri) === undefined) {
          continue;
        }
        const detached = this.live.detachedIn(document);
        for (const annotation of this.store.forFile(document.uri)) {
          if (annotation.orphaned === true || detached.has(annotation.id)) {
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
        for (const entry of thread.comments) {
          if (entry instanceof ThreadComment && entry.mode === vscode.CommentMode.Editing) {
            this.collectLostEdit(entry);
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
      const existing = this.threads.get(id) ?? this.attach(entry.document, entry.annotation);
      if (!existing) {
        continue;
      }
      existing.range = this.live.rangeFor(entry.document, entry.annotation);
      this.fill(existing, entry.annotation);
    }
  }

  private reposition(document: vscode.TextDocument): void {
    if (this.store.relative(document.uri) === undefined) {
      return;
    }
    const spans = this.live.spansFor(document);
    for (const annotation of this.store.forFile(document.uri)) {
      const thread = this.threads.get(annotation.id);
      if (thread) {
        thread.range = this.live.rangeFor(document, annotation, spans);
      }
    }
  }

  dispose(): void {
    if (this.lostTimer) {
      clearTimeout(this.lostTimer);
      this.lostTimer = undefined;
    }
    this.lost.length = 0;
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

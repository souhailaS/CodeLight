import * as vscode from "vscode";
import { HighlightCommands } from "./highlights";
import { newId, timestamp } from "./ids";
import { IdentityProvider } from "./identity";
import { Annotation, Author, Comment } from "./model";
import { toRelativePath } from "./paths";
import { AnnotationStore } from "./store";

const MAX_BODY = 2000;
const CREATE = "create";

function label(comment: Comment): string {
  const body = comment.body.replace(/\s+/g, " ").trim();
  return body.length > 60 ? `${body.slice(0, 60)}…` : body;
}

export class CommentCommands {
  constructor(
    private readonly store: AnnotationStore,
    private readonly identity: IdentityProvider,
    private readonly highlights: HighlightCommands
  ) {}

  async add(annotationId?: string): Promise<void> {
    const target = await this.target(annotationId);
    if (target === undefined) {
      return;
    }
    if (target === CREATE) {
      await this.highlights.add((author) => this.compose(author));
      return;
    }
    const author = await this.identity.require();
    if (!author) {
      return;
    }
    const comment = await this.compose({ login: author.login, id: author.id });
    if (!comment) {
      return;
    }
    const now = comment.createdAt;
    let ran = false;
    let found = false;
    let lost = false;
    const saved = await this.store.transaction((annotations) => {
      ran = true;
      const current = annotations.get(target.id);
      if (!current) {
        return false;
      }
      if (current.orphaned === true) {
        lost = true;
        return false;
      }
      found = true;
      annotations.set(target.id, {
        ...current,
        updatedAt: now,
        comments: [...current.comments, comment]
      });
      return true;
    });
    if (!ran) {
      void vscode.window.showWarningMessage("CodeLight could not update the shared file.");
      return;
    }
    if (lost) {
      void vscode.window.showWarningMessage(
        "That highlight lost its text while you were typing, so the comment was not saved."
      );
      return;
    }
    if (!found) {
      await this.store.refresh();
      void vscode.window.showWarningMessage("That highlight is no longer in the shared file.");
      return;
    }
    if (!saved) {
      void vscode.window.showWarningMessage("CodeLight could not save the comment.");
    }
  }

  private async compose(author: Author): Promise<Comment | undefined> {
    const body = await this.prompt("Add a comment", "");
    if (body === undefined) {
      return undefined;
    }
    const now = timestamp();
    return { id: newId(), author, body, createdAt: now, updatedAt: now };
  }

  async edit(annotationId?: string): Promise<void> {
    const picked = await this.pickComment(annotationId, "Edit comment");
    if (!picked) {
      return;
    }
    const author = await this.identity.require();
    if (!author) {
      return;
    }
    if (picked.comment.author.id !== author.id) {
      void vscode.window.showWarningMessage(
        `That comment belongs to ${picked.comment.author.login}. You can only edit your own.`
      );
      return;
    }
    const body = await this.prompt("Edit comment", picked.comment.body);
    if (body === undefined || body === picked.comment.body) {
      return;
    }
    const now = timestamp();
    await this.rewrite(picked, (comments) =>
      comments.map((entry) =>
        entry.id === picked.comment.id ? { ...entry, body, updatedAt: now } : entry
      )
    );
  }

  async remove(annotationId?: string): Promise<void> {
    const picked = await this.pickComment(annotationId, "Delete comment");
    if (!picked) {
      return;
    }
    const author = await this.identity.require();
    if (!author) {
      return;
    }
    if (picked.comment.author.id !== author.id) {
      void vscode.window.showWarningMessage(
        `That comment belongs to ${picked.comment.author.login}. You can only delete your own.`
      );
      return;
    }
    const confirmed = await vscode.window.showWarningMessage(
      "Delete this comment?",
      { modal: true },
      "Delete"
    );
    if (confirmed !== "Delete") {
      return;
    }
    await this.rewrite(picked, (comments) =>
      comments.filter((entry) => entry.id !== picked.comment.id)
    );
  }

  private async rewrite(
    picked: { annotation: Annotation; comment: Comment },
    change: (comments: Comment[]) => Comment[]
  ): Promise<void> {
    let ran = false;
    let found = false;
    const saved = await this.store.transaction((annotations) => {
      ran = true;
      const current = annotations.get(picked.annotation.id);
      if (!current || !current.comments.some((entry) => entry.id === picked.comment.id)) {
        return false;
      }
      found = true;
      annotations.set(picked.annotation.id, {
        ...current,
        updatedAt: timestamp(),
        comments: change(current.comments)
      });
      return true;
    });
    if (!ran) {
      void vscode.window.showWarningMessage("CodeLight could not update the shared file.");
      return;
    }
    if (!found) {
      void vscode.window.showWarningMessage("That comment is no longer in the shared file.");
      return;
    }
    if (!saved) {
      void vscode.window.showWarningMessage("CodeLight could not save the comment.");
    }
  }

  private async target(annotationId?: string): Promise<Annotation | typeof CREATE | undefined> {
    if (annotationId !== undefined) {
      const existing = this.store.byId(annotationId);
      if (!existing) {
        void vscode.window.showWarningMessage("That highlight is no longer in the shared file.");
        return undefined;
      }
      return this.live(existing);
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage("Open a file to comment on.");
      return undefined;
    }
    const root = this.store.rootUri;
    const relative = root ? toRelativePath(root, editor.document.uri) : undefined;
    if (!relative) {
      const folder = root ? root.path.split("/").pop() : undefined;
      void vscode.window.showWarningMessage(
        folder
          ? `CodeLight is tracking the folder ${folder} and cannot annotate files outside it.`
          : "CodeLight needs an open folder."
      );
      return undefined;
    }
    const primary = editor.selection;
    if (editor.selections.length > 1) {
      return CREATE;
    }
    if (!primary.isEmpty) {
      const enclosing = this.highlights.enclosing(primary);
      if (enclosing.length === 0) {
        return CREATE;
      }
      const picked =
        enclosing.length === 1
          ? enclosing[0]
          : await this.highlights.pickAtCursor("Comment on highlight", enclosing);
      return picked ? this.live(picked) : undefined;
    }
    const candidates = this.highlights
      .atCursor()
      .filter((entry) => entry.orphaned !== true && !this.highlights.isCollapsed(entry));
    if (candidates.length === 0) {
      return CREATE;
    }
    const picked = await this.highlights.pickAtCursor("Comment on highlight", candidates);
    return picked ? this.live(picked) : undefined;
  }

  private live(annotation: Annotation): Annotation | undefined {
    if (annotation.orphaned === true || this.highlights.isCollapsed(annotation)) {
      void vscode.window.showWarningMessage(
        "That highlight lost its text. Remove it instead of commenting on it."
      );
      return undefined;
    }
    return annotation;
  }

  private async pickComment(
    annotationId: string | undefined,
    title: string
  ): Promise<{ annotation: Annotation; comment: Comment } | undefined> {
    let annotation: Annotation | undefined;
    if (annotationId === undefined) {
      const threaded = this.highlights.atCursor().filter((entry) => entry.comments.length > 0);
      if (threaded.length === 0) {
        void vscode.window.showInformationMessage("No commented highlight at the cursor.");
        return undefined;
      }
      annotation = await this.highlights.pickAtCursor(title, threaded);
    } else {
      annotation = this.store.byId(annotationId);
      if (!annotation) {
        void vscode.window.showWarningMessage("That highlight is no longer in the shared file.");
      }
    }
    if (!annotation) {
      return undefined;
    }
    if (annotation.comments.length === 0) {
      void vscode.window.showInformationMessage("That highlight has no comments.");
      return undefined;
    }
    if (annotation.comments.length === 1) {
      return { annotation, comment: annotation.comments[0] };
    }
    const picked = await vscode.window.showQuickPick(
      annotation.comments.map((comment) => ({
        label: label(comment),
        description: `@${comment.author.login}`,
        comment
      })),
      { title }
    );
    return picked ? { annotation, comment: picked.comment } : undefined;
  }

  private async prompt(title: string, value: string): Promise<string | undefined> {
    const body = await vscode.window.showInputBox({
      title,
      value,
      ignoreFocusOut: true,
      prompt: "Shared with everyone who pulls this repository",
      validateInput: (input) => {
        if (input.trim() === "") {
          return "A comment cannot be empty.";
        }
        return input.length > MAX_BODY ? `Keep it under ${MAX_BODY} characters.` : undefined;
      }
    });
    return body === undefined ? undefined : body.trim();
  }
}

import * as vscode from "vscode";
import { HighlightCommands } from "./highlights";
import { newId, timestamp } from "./ids";
import { IdentityProvider } from "./identity";
import { Annotation, Comment } from "./model";
import { AnnotationStore } from "./store";

const MAX_BODY = 2000;

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
    const author = await this.identity.require();
    if (!author) {
      return;
    }
    const annotation = await this.resolve(annotationId);
    if (!annotation) {
      return;
    }
    const body = await this.prompt("Add a comment", "");
    if (body === undefined) {
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
    const saved = await this.store.update(annotation.id, (current) => ({
      ...current,
      updatedAt: now,
      comments: [...current.comments, comment]
    }));
    if (!saved) {
      void vscode.window.showWarningMessage("CodeLight could not save the comment.");
    }
  }

  async edit(annotationId?: string): Promise<void> {
    const author = await this.identity.require();
    if (!author) {
      return;
    }
    const picked = await this.pickComment(annotationId, "Edit comment");
    if (!picked) {
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
    const saved = await this.store.update(picked.annotation.id, (current) => ({
      ...current,
      updatedAt: now,
      comments: current.comments.map((entry) =>
        entry.id === picked.comment.id ? { ...entry, body, updatedAt: now } : entry
      )
    }));
    if (!saved) {
      void vscode.window.showWarningMessage("CodeLight could not save the comment.");
    }
  }

  async remove(annotationId?: string): Promise<void> {
    const author = await this.identity.require();
    if (!author) {
      return;
    }
    const picked = await this.pickComment(annotationId, "Delete comment");
    if (!picked) {
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
    const saved = await this.store.update(picked.annotation.id, (current) => ({
      ...current,
      updatedAt: timestamp(),
      comments: current.comments.filter((entry) => entry.id !== picked.comment.id)
    }));
    if (!saved) {
      void vscode.window.showWarningMessage("CodeLight could not delete the comment.");
    }
  }

  private async resolve(annotationId?: string): Promise<Annotation | undefined> {
    if (annotationId !== undefined) {
      const existing = this.store.byId(annotationId);
      if (!existing) {
        void vscode.window.showWarningMessage("That highlight is no longer in the shared file.");
      }
      return existing;
    }
    if (this.highlights.atCursor().length > 0) {
      return this.highlights.pickAtCursor("Comment on highlight");
    }
    const created = await this.highlights.add();
    return created[0];
  }

  private async pickComment(
    annotationId: string | undefined,
    title: string
  ): Promise<{ annotation: Annotation; comment: Comment } | undefined> {
    const annotation =
      annotationId === undefined
        ? await this.highlights.pickAtCursor(title)
        : this.store.byId(annotationId);
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

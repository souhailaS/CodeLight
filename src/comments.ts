import * as vscode from "vscode";
import { HighlightCommands } from "./highlights";
import { timestamp } from "./ids";
import { IdentityProvider } from "./identity";
import { Annotation, Comment, MAX_COMMENT_BODY } from "./model";
import { AnnotationStore } from "./store";

const CREATE = "create";

export type Located = { kind: "open"; id: string } | { kind: "draft" } | { kind: "abort" };

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

  async locate(): Promise<Located> {
    const target = await this.target();
    if (target === undefined) {
      return { kind: "abort" };
    }
    return target === CREATE ? { kind: "draft" } : { kind: "open", id: target.id };
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
    const saved = await this.store.transaction(picked.annotation.root, (annotations) => {
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

  private async target(): Promise<Annotation | typeof CREATE | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage("Open a file to comment on.");
      return undefined;
    }
    if (this.store.relative(editor.document.uri) === undefined) {
      void vscode.window.showWarningMessage(
        this.store.isReady
          ? "CodeLight can only annotate files inside a folder of this workspace."
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
    const candidates = this.highlights.atCursorLive();
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
        return input.length > MAX_COMMENT_BODY ? `Keep it under ${MAX_COMMENT_BODY} characters.` : undefined;
      }
    });
    return body === undefined ? undefined : body.trim();
  }
}

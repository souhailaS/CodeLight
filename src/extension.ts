import * as vscode from "vscode";
import { CommentCommands } from "./comments";
import { HighlightRenderer } from "./decorations";
import { FileCommentsView } from "./fileview";
import { HighlightCommands } from "./highlights";
import { IdentityProvider } from "./identity";
import { AnnotationTree, Node, nodeId, PanelCommands } from "./panel";
import { LiveRanges } from "./live";
import { AnnotationStore } from "./store";
import { ThreadComment, ThreadView } from "./threads";

export function activate(context: vscode.ExtensionContext): void {
  const identity = new IdentityProvider();
  const store = new AnnotationStore();
  const live = new LiveRanges(store);
  const renderer = new HighlightRenderer(store, live);
  const highlights = new HighlightCommands(store, identity, renderer, live);
  const comments = new CommentCommands(store, identity, highlights);
  const threads = new ThreadView(store, live, identity);
  const tree = new AnnotationTree(store);
  const panel = new PanelCommands(store, live, tree);
  const view = vscode.window.createTreeView("codelight.annotations", {
    treeDataProvider: tree,
    showCollapseAll: true
  });
  const fileComments = new FileCommentsView(store, live);
  const ready = Promise.all([identity.refresh(), store.initialize()]).catch(() => undefined);

  context.subscriptions.push(
    identity,
    store,
    live,
    renderer,
    threads,
    tree,
    view,
    fileComments,
    vscode.window.registerWebviewViewProvider(FileCommentsView.viewId, fileComments),
    vscode.commands.registerCommand("codelight.threadReply", async (reply: vscode.CommentReply) => {
      await ready;
      await threads.reply(reply);
    }),
    vscode.commands.registerCommand(
      "codelight.threadHighlightOnly",
      async (target?: vscode.CommentReply | vscode.CommentThread) => {
        await ready;
        await threads.highlightOnly(target);
      }
    ),
    vscode.commands.registerCommand(
      "codelight.threadDeleteHighlight",
      async (thread?: vscode.CommentThread) => {
        await ready;
        await threads.deleteHighlight(thread);
      }
    ),
    vscode.commands.registerCommand("codelight.threadDiscard", (thread?: vscode.CommentThread) => {
      threads.discard(thread);
    }),
    vscode.commands.registerCommand("codelight.threadEdit", (comment: ThreadComment) => {
      threads.edit(comment);
    }),
    vscode.commands.registerCommand("codelight.threadSave", async (comment: ThreadComment) => {
      await threads.saveEdit(comment);
    }),
    vscode.commands.registerCommand("codelight.threadCancel", (comment: ThreadComment) => {
      threads.cancelEdit(comment);
    }),
    vscode.commands.registerCommand("codelight.threadDelete", async (comment: ThreadComment) => {
      await threads.deleteComment(comment);
    }),
    vscode.commands.registerCommand("codelight.showPanel", async () => {
      await vscode.commands.executeCommand("codelight.annotations.focus");
    }),
    vscode.commands.registerCommand("codelight.revealAnnotation", async (id: string) => {
      await ready;
      await panel.reveal(id);
    }),
    vscode.commands.registerCommand("codelight.deleteAnnotation", async (node?: Node | string) => {
      await ready;
      await panel.deleteAnnotation(node);
    }),
    vscode.commands.registerCommand("codelight.deleteFileHighlights", async (node?: Node) => {
      await ready;
      await panel.deleteFile(node);
    }),
    vscode.commands.registerCommand("codelight.deleteOrphansEverywhere", async () => {
      await ready;
      await panel.deleteOrphansEverywhere();
    }),
    vscode.commands.registerCommand("codelight.filterByColor", async () => {
      await ready;
      await panel.filterByColor();
    }),
    vscode.commands.registerCommand("codelight.clearFilter", () => {
      panel.clearFilter();
    }),
    vscode.commands.registerCommand("codelight.signIn", async () => {
      const account = await identity.require();
      if (account) {
        void vscode.window.showInformationMessage(`CodeLight is signed in as ${account.login}.`);
      }
    }),
    vscode.commands.registerCommand("codelight.addHighlight", async () => {
      await ready;
      await highlights.add();
    }),
    vscode.commands.registerCommand("codelight.removeHighlight", async () => {
      await ready;
      await highlights.remove();
    }),
    vscode.commands.registerCommand("codelight.changeColor", async () => {
      await ready;
      await highlights.recolor();
    }),
    vscode.commands.registerCommand("codelight.removeOrphaned", async () => {
      await ready;
      await highlights.removeOrphaned();
    }),
    vscode.commands.registerCommand("codelight.addComment", async () => {
      await ready;
      const located = await comments.locate();
      if (located.kind === "abort") {
        return;
      }
      if (located.kind === "open") {
        await threads.open(located.id);
        return;
      }
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage("Open a file to comment on.");
        return;
      }
      await threads.openDraft(editor);
    }),
    vscode.commands.registerCommand("codelight.reply", async (target?: unknown) => {
      await ready;
      const id = nodeId(target);
      if (id !== undefined) {
        await threads.open(id);
        return;
      }
      const located = await comments.locate();
      if (located.kind === "open") {
        await threads.open(located.id);
        return;
      }
      if (located.kind === "draft") {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          void vscode.window.showWarningMessage("Open a file to comment on.");
          return;
        }
        await threads.openDraft(editor);
      }
    }),
    vscode.commands.registerCommand("codelight.editComment", async (target?: unknown) => {
      await ready;
      await comments.edit(nodeId(target));
    }),
    vscode.commands.registerCommand("codelight.deleteComment", async (target?: unknown) => {
      await ready;
      await comments.remove(nodeId(target));
    }),
    vscode.commands.registerCommand("codelight.showStatus", async () => {
      await ready;
      if (!store.isReady) {
        void vscode.window.showWarningMessage("CodeLight needs an open folder.");
        return;
      }
      const account = identity.identity;
      const who = account ? account.login : "nobody";
      void vscode.window.showInformationMessage(
        `CodeLight tracks ${store.all.length} annotations, signed in as ${who}.`
      );
    })
  );
}

export function deactivate(): void {}

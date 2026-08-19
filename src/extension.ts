import * as vscode from "vscode";
import { CommentCommands } from "./comments";
import { HighlightRenderer } from "./decorations";
import { FileCommentsView } from "./fileview";
import { keepPrivate, stopKeepingPrivate } from "./gitignore";
import { HighlightCommands, useSwatches } from "./highlights";
import { IdentityProvider, sourceOf } from "./identity";
import { AnnotationTree, Node, nodeId, PanelCommands } from "./panel";
import { LiveRanges } from "./live";
import { RenameWatcher } from "./renames";
import { MarkerMode } from "./marker";
import { SignInNudge } from "./nudge";
import { SharingState } from "./sharing";
import { FileStatus } from "./statusbar";
import { AnnotationStore } from "./store";
import { Visibility } from "./visibility";
import { Swatches } from "./swatches";
import { ThreadComment, ThreadView } from "./threads";

export function activate(context: vscode.ExtensionContext): void {
  const identity = new IdentityProvider(undefined, context.globalState);
  const store = new AnnotationStore();
  const live = new LiveRanges(store);
  const visibility = new Visibility();
  const renderer = new HighlightRenderer(store, live, visibility);
  useSwatches(new Swatches(context.globalStorageUri));
  const sharing = new SharingState();
  const nudge = new SignInNudge(store, sharing);
  const highlights = new HighlightCommands(store, identity, renderer, live, visibility, nudge);
  const marker = new MarkerMode(identity, store, renderer, highlights, live, visibility);
  const status = new FileStatus(store, visibility, sharing);
  const comments = new CommentCommands(store, identity, highlights);
  const threads = new ThreadView(store, live, identity, visibility, sharing, nudge);
  const tree = new AnnotationTree(store, live);
  const panel = new PanelCommands(store, live, tree);
  const view = vscode.window.createTreeView("codelight.annotations", {
    treeDataProvider: tree,
    showCollapseAll: true
  });
  const fileComments = new FileCommentsView(store, live, sharing);
  const ready = store.initialize().catch(() => undefined);
  const renames = new RenameWatcher(store, ready);
  void ready.then(() => fileComments.ready());
  void identity.prime();

  context.subscriptions.push(
    identity,
    store,
    live,
    renames,
    renderer,
    marker,
    status,
    visibility,
    vscode.commands.registerCommand("codelight.toggleVisibility", () => {
      visibility.toggle();
    }),
    vscode.commands.registerCommand("codelight.showAgain", () => {
      visibility.show();
    }),
    vscode.commands.registerCommand("codelight.markerOn", async () => {
      await ready;
      await marker.toggle();
    }),
    vscode.commands.registerCommand("codelight.markerOff", () => {
      marker.off();
    }),
    vscode.commands.registerCommand("codelight.openWalkthrough", async () => {
      await vscode.commands.executeCommand(
        "workbench.action.openWalkthrough",
        `${context.extension.id}#codelight.start`,
        false
      );
    }),
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
    vscode.commands.registerCommand(
      "codelight.threadDiscard",
      async (target?: vscode.CommentReply | vscode.CommentThread) => {
        await threads.discard(target);
      }
    ),
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
      const account = await identity.signIn();
      if (account) {
        void vscode.window.showInformationMessage(`CodeLight is signed in as ${account.login}.`);
        return;
      }
      const local = await identity.local();
      void vscode.window.showWarningMessage(
        `CodeLight is not signed in, so new notes carry ${sourceOf(local)}, ${local.login}.`
      );
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
    vscode.commands.registerCommand("codelight.keepPrivate", async () => {
      await ready;
      if (!store.isReady) {
        void vscode.window.showWarningMessage("CodeLight needs an open folder.");
        return;
      }
      const root = await store.pickFolder("Pick the folder to keep out of git");
      if (root) {
        await keepPrivate(root);
      }
    }),
    vscode.commands.registerCommand("codelight.shareInGit", async () => {
      await ready;
      if (!store.isReady) {
        void vscode.window.showWarningMessage("CodeLight needs an open folder.");
        return;
      }
      const root = await store.pickFolder("Pick the folder to take out of .gitignore");
      if (root) {
        await stopKeepingPrivate(root);
      }
    }),
    vscode.commands.registerCommand("codelight.resolveConflict", async () => {
      await ready;
      await store.resolveConflict();
    }),
    vscode.commands.registerCommand("codelight.convertStorage", async () => {
      await ready;
      await store.convertStorage();
    }),
    vscode.commands.registerCommand("codelight.showStatus", async () => {
      await ready;
      if (!store.isReady) {
        void vscode.window.showWarningMessage("CodeLight needs an open folder.");
        return;
      }
      const account = identity.identity ?? (await identity.local());
      const count = store.all.length;
      const who = account.verified
        ? `signed in as ${account.login}`
        : `signing notes ${account.login}, ${sourceOf(account)}`;
      void vscode.window.showInformationMessage(
        `CodeLight tracks ${count} annotation${count === 1 ? "" : "s"}, ${who}.`
      );
    })
  );
}

export function deactivate(): void {}

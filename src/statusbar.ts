import * as vscode from "vscode";
import { toRelativePath } from "./paths";
import { AnnotationStore } from "./store";
import { Visibility } from "./visibility";

export class FileStatus implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: AnnotationStore,
    private readonly visibility: Visibility
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.item.command = "codelight.showPanel";
    this.disposables.push(
      this.item,
      store.onDidChange(() => this.refresh()),
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      visibility.onDidChange(() => this.refresh())
    );
    this.refresh();
  }

  private refresh(): void {
    const editor = vscode.window.activeTextEditor;
    const root = this.store.rootUri;
    const relative = editor && root ? toRelativePath(root, editor.document.uri) : undefined;
    if (!relative) {
      this.item.hide();
      return;
    }
    const annotations = this.store.forFile(relative);
    if (annotations.length === 0) {
      this.item.hide();
      return;
    }
    const comments = annotations.reduce((sum, entry) => sum + entry.comments.length, 0);
    const notes = `${annotations.length} highlight${annotations.length === 1 ? "" : "s"}`;
    const icon = this.visibility.visible ? "$(bookmark)" : "$(eye-closed)";
    this.item.text = comments === 0 ? `${icon} ${notes}` : `${icon} ${notes}, ${comments}`;
    const detail =
      comments === 0
        ? `CodeLight, ${notes} in this file`
        : `CodeLight, ${notes} and ${comments} comment${comments === 1 ? "" : "s"} in this file`;
    this.item.tooltip = this.visibility.visible ? detail : `${detail}, currently hidden`;
    this.item.show();
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

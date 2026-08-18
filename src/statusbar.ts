import * as vscode from "vscode";
import { describeSharing, SharingState } from "./sharing";
import { AnnotationStore } from "./store";
import { Visibility } from "./visibility";

export class FileStatus implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: AnnotationStore,
    private readonly visibility: Visibility,
    private readonly sharing = new SharingState()
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.item.command = "codelight.showPanel";
    this.disposables.push(
      this.item,
      store.onDidChange(() => {
        this.sharing.forget();
        this.refresh();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      visibility.onDidChange(() => this.refresh())
    );
    this.refresh();
  }

  private refresh(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.item.hide();
      return;
    }
    const all = this.store.forFile(editor.document.uri);
    if (all.length === 0) {
      this.item.hide();
      return;
    }
    const annotations = all.filter((annotation) => annotation.orphaned !== true);
    const stranded = all.length - annotations.length;
    const comments = all.reduce((sum, entry) => sum + entry.comments.length, 0);
    const notes = `${annotations.length} highlight${annotations.length === 1 ? "" : "s"}`;
    const icon = this.visibility.visible ? "$(bookmark)" : "$(eye-closed)";
    const counts = comments === 0 ? notes : `${notes}, ${comments}`;
    this.item.text = stranded === 0 ? `${icon} ${counts}` : `${icon} ${counts} $(circle-slash)${stranded}`;
    const detail =
      comments === 0
        ? `CodeLight, ${notes} in this file`
        : `CodeLight, ${notes} and ${comments} comment${comments === 1 ? "" : "s"} in this file`;
    const withStranded =
      stranded === 0
        ? detail
        : `${detail}, plus ${stranded} stranded because the text they marked is gone`;
    const seen = this.visibility.visible ? withStranded : `${withStranded}, currently hidden`;
    this.item.tooltip = this.say(seen, editor.document.uri);
    this.item.show();
  }

  private say(detail: string, target: vscode.Uri): string {
    const store = this.store.storeAt(target)?.location;
    if (!store) {
      return detail;
    }
    const known = this.sharing.known(store);
    if (known === undefined) {
      void this.sharing.of(store).then(() => this.refresh());
      return detail;
    }
    const sharing = describeSharing(known);
    return sharing === "" ? detail : `${detail}. ${sharing[0].toUpperCase()}${sharing.slice(1)}`;
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

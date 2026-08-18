import * as vscode from "vscode";

export class Visibility implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<boolean>();
  private shown = true;

  readonly onDidChange = this.emitter.event;

  constructor() {
    void vscode.commands.executeCommand("setContext", "codelight.hidden", false);
  }

  get visible(): boolean {
    return this.shown;
  }

  show(): boolean {
    if (this.shown) {
      return false;
    }
    this.toggle();
    return true;
  }

  toggle(): void {
    this.shown = !this.shown;
    void vscode.commands.executeCommand("setContext", "codelight.hidden", !this.shown);
    this.emitter.fire(this.shown);
    void vscode.window.setStatusBarMessage(
      this.shown ? "CodeLight notes shown" : "CodeLight notes hidden",
      2000
    );
  }

  dispose(): void {
    void vscode.commands.executeCommand("setContext", "codelight.hidden", false);
    this.emitter.dispose();
  }
}

import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("codelight.showStatus", () => {
      const active = vscode.window.activeTextEditor;
      const folder = active
        ? vscode.workspace.getWorkspaceFolder(active.document.uri)
        : vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        void vscode.window.showWarningMessage("CodeLight needs an open folder.");
        return;
      }
      void vscode.window.showInformationMessage(`CodeLight is active in ${folder.name}.`);
    })
  );
}

export function deactivate(): void {}

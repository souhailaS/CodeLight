import * as vscode from "vscode";
import { IdentityProvider } from "./identity";
import { AnnotationStore } from "./store";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const identity = new IdentityProvider();
  const store = new AnnotationStore();
  context.subscriptions.push(identity, store);

  await identity.refresh();
  await store.initialize();

  context.subscriptions.push(
    vscode.commands.registerCommand("codelight.signIn", async () => {
      const account = await identity.require();
      if (account) {
        void vscode.window.showInformationMessage(`CodeLight is signed in as ${account.login}.`);
      }
    }),
    vscode.commands.registerCommand("codelight.showStatus", () => {
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

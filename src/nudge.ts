import * as vscode from "vscode";
import { Identity, sourceOf } from "./identity";
import { SharingState } from "./sharing";
import { AnnotationStore } from "./store";

export class SignInNudge {
  private asked = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: AnnotationStore,
    private readonly sharing: SharingState
  ) {}

  about(target: vscode.Uri, author: Identity): Promise<void> {
    const next = this.queue.then(
      () => this.consider(target, author),
      () => this.consider(target, author)
    );
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private async consider(target: vscode.Uri, author: Identity): Promise<void> {
    if (author.verified || this.asked) {
      return;
    }
    const store = this.store.storeAt(target)?.location;
    const state = store ? await this.sharing.of(store) : "unknown";
    if (state !== "tracked" && state !== "untracked") {
      return;
    }
    this.asked = true;
    const carried =
      state === "tracked"
        ? "This annotation file is one git carries, so anyone who has the repository will see these notes"
        : "This annotation file is not committed yet, and once it is anyone who has the repository will see these notes";
    void vscode.window
      .showInformationMessage(
        `${carried} signed ${author.login}, ${sourceOf(author)}. Sign in with GitHub to use your account instead.`,
        "Sign in with GitHub"
      )
      .then((chosen) => {
        if (chosen === "Sign in with GitHub") {
          void vscode.commands.executeCommand("codelight.signIn");
        }
      });
  }
}

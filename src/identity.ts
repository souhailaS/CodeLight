import * as vscode from "vscode";
import { Author } from "./model";

const PROVIDER = "github";
const SCOPES = ["read:user"];

export interface Identity extends Author {
  avatarUrl: string;
}

function toIdentity(session: vscode.AuthenticationSession): Identity {
  const login = session.account.label.trim();
  const id = session.account.id.trim();
  return {
    login,
    id,
    avatarUrl: `https://avatars.githubusercontent.com/u/${encodeURIComponent(id)}`
  };
}

export class IdentityProvider implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Identity | undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private current: Identity | undefined;

  readonly onDidChange = this.emitter.event;

  constructor() {
    this.disposables.push(
      vscode.authentication.onDidChangeSessions((event) => {
        if (event.provider.id !== PROVIDER) {
          return;
        }
        void this.refresh();
      })
    );
  }

  get identity(): Identity | undefined {
    return this.current;
  }

  async refresh(): Promise<Identity | undefined> {
    let session: vscode.AuthenticationSession | undefined;
    try {
      session = await vscode.authentication.getSession(PROVIDER, SCOPES, { silent: true });
    } catch {
      return this.current;
    }
    const next = session ? toIdentity(session) : undefined;
    const changed =
      next?.id !== this.current?.id || next?.login !== this.current?.login;
    this.current = next;
    if (changed) {
      this.emitter.fire(next);
    }
    return next;
  }

  async signIn(): Promise<Identity | undefined> {
    try {
      const session = await vscode.authentication.getSession(PROVIDER, SCOPES, {
        createIfNone: true
      });
      const identity = toIdentity(session);
      this.current = identity;
      this.emitter.fire(identity);
      return identity;
    } catch {
      return undefined;
    }
  }

  async require(): Promise<Identity | undefined> {
    if (this.current) {
      return this.current;
    }
    const existing = await this.refresh();
    if (existing) {
      return existing;
    }
    const identity = await this.signIn();
    if (!identity) {
      void vscode.window.showWarningMessage(
        "CodeLight needs a GitHub sign in so annotations can be attributed to you."
      );
    }
    return identity;
  }

  dispose(): void {
    this.emitter.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

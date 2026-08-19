import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as vscode from "vscode";
import { Author } from "./model";

const PROVIDER = "github";
const SCOPES = ["read:user"];

export interface Identity extends Author {
  avatarUrl: string;
  verified: boolean;
}

export type Asker = (args: string[]) => Promise<string | undefined>;

function askGit(args: string[]): Promise<string | undefined> {
  return new Promise((done) => {
    execFile("git", args, { timeout: 3000 }, (error, out) => {
      done(error ? undefined : out.trim());
    });
  });
}

function toIdentity(session: vscode.AuthenticationSession): Identity {
  const login = session.account.label.trim();
  const id = session.account.id.trim();
  return {
    login,
    id,
    avatarUrl: `https://avatars.githubusercontent.com/u/${encodeURIComponent(id)}`,
    verified: true
  };
}

export function localId(seed: string): string {
  return `local:${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

export class IdentityProvider implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Identity | undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private current: Identity | undefined;
  private mine: Identity | undefined;

  readonly onDidChange = this.emitter.event;

  constructor(private readonly ask: Asker = askGit) {
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
    return this.local();
  }

  async local(): Promise<Identity> {
    if (this.mine) {
      return this.mine;
    }
    const name = (await this.ask(["config", "user.name"])) ?? "";
    const email = (await this.ask(["config", "user.email"])) ?? "";
    const login = name !== "" ? name : email !== "" ? email : os.userInfo().username;
    this.mine = {
      login,
      id: localId(email !== "" ? email : login),
      avatarUrl: "",
      verified: false
    };
    return this.mine;
  }

  dispose(): void {
    this.emitter.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

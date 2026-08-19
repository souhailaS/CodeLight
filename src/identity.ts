import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as os from "node:os";
import * as vscode from "vscode";
import { Author } from "./model";

const PROVIDER = "github";
const SCOPES = ["read:user"];

export type Source = "github" | "git" | "machine";

export interface Identity extends Author {
  avatarUrl: string;
  verified: boolean;
  source: Source;
}

export type Asker = (args: string[], cwd?: string) => Promise<string | undefined>;

export interface Remembers {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

const INSTALLATION = "codelight.installation";

function askGit(args: string[], cwd?: string): Promise<string | undefined> {
  return new Promise((done) => {
    execFile("git", args, { cwd, timeout: 3000 }, (error, out) => {
      done(error ? undefined : out.trim());
    });
  });
}

function machine(): string {
  try {
    return os.userInfo().username;
  } catch {
    return "someone";
  }
}

function toIdentity(session: vscode.AuthenticationSession): Identity {
  const login = session.account.label.trim();
  const id = session.account.id.trim();
  return {
    login,
    id,
    avatarUrl: `https://avatars.githubusercontent.com/u/${encodeURIComponent(id)}`,
    verified: true,
    source: "github"
  };
}

export function sourceOf(who: Identity): string {
  if (who.source === "github") {
    return "the GitHub account you signed in with";
  }
  return who.source === "git"
    ? "the name git knows you by"
    : "the account name on this machine, since git knows you by no other";
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

  private pending: Promise<Identity> | undefined;
  private generation = 0;

  constructor(
    private readonly ask: Asker = askGit,
    private readonly memory?: Remembers
  ) {
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
    const asked = this.generation;
    let session: vscode.AuthenticationSession | undefined;
    try {
      session = await vscode.authentication.getSession(PROVIDER, SCOPES, { silent: true });
    } catch {
      return this.current;
    }
    if (asked !== this.generation) {
      return this.current;
    }
    return this.adopt(session ? toIdentity(session) : this.mine);
  }

  async signIn(): Promise<Identity | undefined> {
    try {
      const session = await vscode.authentication.getSession(PROVIDER, SCOPES, {
        createIfNone: true
      });
      this.generation += 1;
      return this.adopt(toIdentity(session));
    } catch {
      return undefined;
    }
  }

  private adopt(next: Identity | undefined): Identity | undefined {
    const changed = next?.id !== this.current?.id || next?.login !== this.current?.login;
    this.current = next;
    if (changed) {
      this.emitter.fire(next);
    }
    return next;
  }

  async require(): Promise<Identity> {
    if (this.current) {
      return this.current;
    }
    const existing = await this.refresh();
    if (existing) {
      return existing;
    }
    return this.local();
  }

  async prime(): Promise<void> {
    await this.refresh().catch(() => undefined);
    await this.local().catch(() => undefined);
  }

  async local(): Promise<Identity> {
    if (this.mine) {
      return this.mine;
    }
    this.pending ??= this.resolveLocal().catch(() => this.fallback());
    return this.pending;
  }

  owns(author: Author): boolean {
    return author.id === this.current?.id || author.id === this.mine?.id;
  }

  private async resolveLocal(): Promise<Identity> {
    const { name, email } = await this.fromGit();
    const address = email.trim().toLowerCase();
    const who = name.trim();
    const login = who !== "" ? who : address !== "" ? address : machine();
    const seed = address !== "" ? address : await this.installation();
    return this.keep({
      login,
      id: localId(seed),
      avatarUrl: "",
      verified: false,
      source: address !== "" || who !== "" ? "git" : "machine"
    });
  }

  private fallback(): Identity {
    return this.keep({
      login: machine(),
      id: localId(`${os.hostname()}/${machine()}`),
      avatarUrl: "",
      verified: false,
      source: "machine"
    });
  }

  private keep(mine: Identity): Identity {
    this.mine = mine;
    if (!this.current) {
      this.adopt(mine);
    }
    return mine;
  }

  private async fromGit(): Promise<{ name: string; email: string }> {
    const roots = (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === "file")
      .map((folder) => folder.uri.fsPath);
    for (const cwd of roots.length > 0 ? roots : [undefined]) {
      const [name, email] = await Promise.all([
        this.ask(["config", "user.name"], cwd),
        this.ask(["config", "user.email"], cwd)
      ]);
      if ((name ?? "") !== "" || (email ?? "") !== "") {
        return { name: name ?? "", email: email ?? "" };
      }
    }
    return { name: "", email: "" };
  }

  private async installation(): Promise<string> {
    const stored = this.memory?.get<string>(INSTALLATION);
    if (typeof stored === "string" && stored !== "") {
      return stored;
    }
    const here = `${os.hostname()}/${machine()}`;
    if (!this.memory) {
      return here;
    }
    const fresh = randomUUID();
    const kept = await Promise.race([
      this.memory.update(INSTALLATION, fresh).then(
        () => true,
        () => false
      ),
      new Promise<boolean>((done) => setTimeout(() => done(false), 1000))
    ]);
    return kept ? fresh : here;
  }

  dispose(): void {
    this.emitter.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

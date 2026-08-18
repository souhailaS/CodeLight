import { execFile } from "node:child_process";
import * as vscode from "vscode";

export type Sharing = "ignored" | "tracked" | "untracked" | "loose" | "unknown";

export type Runner = (args: string[], cwd: string) => Promise<number | undefined>;

const CACHE_MS = 5000;

function runGit(args: string[], cwd: string): Promise<number | undefined> {
  return new Promise((done) => {
    const child = execFile("git", args, { cwd, timeout: 4000 }, () => undefined);
    child.on("error", () => done(undefined));
    child.on("close", (code) => done(code ?? undefined));
  });
}

export class SharingState {
  private readonly seen = new Map<string, { at: number; state: Sharing }>();
  private readonly pending = new Map<string, Promise<Sharing>>();

  constructor(private readonly run: Runner = runGit) {}

  forget(): void {
    this.seen.clear();
  }

  known(target: vscode.Uri): Sharing | undefined {
    const entry = this.seen.get(target.fsPath);
    return entry && Date.now() - entry.at < CACHE_MS ? entry.state : undefined;
  }

  async of(target: vscode.Uri): Promise<Sharing> {
    if (target.scheme !== "file") {
      return "unknown";
    }
    const cached = this.known(target);
    if (cached !== undefined) {
      return cached;
    }
    const running = this.pending.get(target.fsPath);
    if (running) {
      return running;
    }
    const started = this.ask(target).then((state) => {
      this.seen.set(target.fsPath, { at: Date.now(), state });
      this.pending.delete(target.fsPath);
      return state;
    });
    this.pending.set(target.fsPath, started);
    return started;
  }

  private async ask(target: vscode.Uri): Promise<Sharing> {
    const folder = vscode.Uri.joinPath(target, "..").fsPath;
    const repository = await this.run(["rev-parse", "--git-dir"], folder);
    if (repository === undefined) {
      return "unknown";
    }
    if (repository !== 0) {
      return "loose";
    }
    const ignored = await this.run(["check-ignore", "--quiet", "--", target.fsPath], folder);
    if (ignored === 0) {
      return "ignored";
    }
    if (ignored === undefined) {
      return "unknown";
    }
    const tracked = await this.run(["ls-files", "--error-unmatch", "--", target.fsPath], folder);
    if (tracked === undefined) {
      return "unknown";
    }
    return tracked === 0 ? "tracked" : "untracked";
  }
}

export function describeSharing(state: Sharing): string {
  if (state === "ignored") {
    return "git ignores these notes, so they stay on this machine";
  }
  if (state === "tracked") {
    return "these notes are committed, so they travel with the repository";
  }
  if (state === "untracked") {
    return "these notes are not committed, so nobody else has them yet";
  }
  return "";
}

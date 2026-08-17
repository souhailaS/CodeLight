import * as vscode from "vscode";
import { Annotation, parseStore, serializeStore } from "./model";
import { storeUri, workspaceRoot } from "./paths";

const RELOAD_DEBOUNCE_MS = 150;

function isMissingFile(error: unknown): boolean {
  if (error instanceof vscode.FileSystemError) {
    return error.code === "FileNotFound";
  }
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AnnotationStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private annotations = new Map<string, Annotation>();
  private root: vscode.Uri | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingWrite: Promise<void> = Promise.resolve();
  private lastSerialized: string | undefined;
  private reportedFailure: string | undefined;
  private reportedDropped = 0;
  private generation = 0;

  readonly onDidChange = this.emitter.event;

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.bind();
      })
    );
  }

  async initialize(): Promise<void> {
    await this.bind();
  }

  get isReady(): boolean {
    return this.root !== undefined;
  }

  get all(): Annotation[] {
    return [...this.annotations.values()];
  }

  get location(): vscode.Uri | undefined {
    return this.root ? storeUri(this.root) : undefined;
  }

  get rootUri(): vscode.Uri | undefined {
    return this.root;
  }

  byId(id: string): Annotation | undefined {
    return this.annotations.get(id);
  }

  forFile(relativePath: string): Annotation[] {
    return this.all.filter((annotation) => annotation.file === relativePath);
  }

  async add(annotation: Annotation): Promise<boolean> {
    if (!this.isReady) {
      return false;
    }
    this.annotations.set(annotation.id, annotation);
    await this.persist();
    return true;
  }

  async update(id: string, mutate: (annotation: Annotation) => Annotation): Promise<boolean> {
    const existing = this.annotations.get(id);
    if (!this.isReady || !existing) {
      return false;
    }
    this.annotations.set(id, mutate(existing));
    await this.persist();
    return true;
  }

  async remove(id: string): Promise<boolean> {
    if (!this.isReady || !this.annotations.delete(id)) {
      return false;
    }
    await this.persist();
    return true;
  }

  private async bind(): Promise<void> {
    const root = workspaceRoot();
    if (this.root?.toString() === root?.toString()) {
      return;
    }
    this.generation += 1;
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = undefined;
    }
    this.watcher?.dispose();
    this.watcher = undefined;
    this.root = root;
    this.annotations = new Map();
    this.lastSerialized = undefined;
    this.reportedFailure = undefined;
    this.reportedDropped = 0;
    if (!root) {
      this.emitter.fire();
      return;
    }
    const pattern = new vscode.RelativePattern(root, ".vscode/codelight.json");
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidCreate(() => this.scheduleReload());
    watcher.onDidChange(() => this.scheduleReload());
    watcher.onDidDelete(() => this.scheduleReload());
    this.watcher = watcher;
    await this.load();
  }

  private scheduleReload(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
    }
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      void this.load();
    }, RELOAD_DEBOUNCE_MS);
  }

  private async load(): Promise<void> {
    const target = this.location;
    if (!target) {
      return;
    }
    const generation = this.generation;
    let raw: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(target);
      if (generation !== this.generation) {
        return;
      }
      raw = Buffer.from(bytes).toString("utf8");
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      if (!isMissingFile(error)) {
        this.reportFailure(`CodeLight could not read ${target.fsPath}. ${describe(error)}`);
        return;
      }
      if (this.annotations.size === 0 && this.lastSerialized === undefined) {
        return;
      }
      this.annotations = new Map();
      this.lastSerialized = undefined;
      this.emitter.fire();
      return;
    }
    if (raw === this.lastSerialized) {
      return;
    }
    try {
      const parsed = parseStore(raw);
      this.annotations = new Map(parsed.annotations.map((entry) => [entry.id, entry]));
      this.lastSerialized = raw;
      this.reportedFailure = undefined;
      this.warnAboutDropped(parsed.dropped, target);
      this.emitter.fire();
    } catch (error) {
      this.reportFailure(`CodeLight could not read ${target.fsPath}. ${describe(error)}`);
    }
  }

  private reportFailure(message: string): void {
    if (this.reportedFailure === message) {
      return;
    }
    this.reportedFailure = message;
    void vscode.window.showErrorMessage(message);
  }

  private warnAboutDropped(dropped: number, target: vscode.Uri): void {
    if (dropped === this.reportedDropped) {
      return;
    }
    this.reportedDropped = dropped;
    if (dropped === 0) {
      return;
    }
    const label = dropped === 1 ? "entry" : "entries";
    void vscode.window.showWarningMessage(
      `CodeLight skipped ${dropped} unreadable ${label} in ${target.fsPath}. They are left in the file until you save a change.`
    );
  }

  private async persist(): Promise<void> {
    const target = this.location;
    if (!target) {
      return;
    }
    const content = serializeStore(this.all);
    const generation = this.generation;
    this.emitter.fire();
    this.pendingWrite = this.pendingWrite.then(async () => {
      try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, ".."));
        await vscode.workspace.fs.writeFile(target, Buffer.from(content, "utf8"));
        if (generation === this.generation) {
          this.lastSerialized = content;
        }
      } catch (error) {
        if (generation === this.generation) {
          this.lastSerialized = undefined;
        }
        void vscode.window.showErrorMessage(`CodeLight could not save annotations. ${describe(error)}`);
      }
    });
    await this.pendingWrite;
  }

  dispose(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
    }
    this.watcher?.dispose();
    this.emitter.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

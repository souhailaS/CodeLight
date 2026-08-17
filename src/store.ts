import * as vscode from "vscode";
import { Annotation, parseStore, serializeStore } from "./model";
import { storeUri, workspaceRoot } from "./paths";

const RELOAD_DEBOUNCE_MS = 150;

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

  async add(annotation: Annotation): Promise<void> {
    this.annotations.set(annotation.id, annotation);
    await this.persist();
  }

  async update(id: string, mutate: (annotation: Annotation) => Annotation): Promise<boolean> {
    const existing = this.annotations.get(id);
    if (!existing) {
      return false;
    }
    this.annotations.set(id, mutate(existing));
    await this.persist();
    return true;
  }

  async remove(id: string): Promise<boolean> {
    if (!this.annotations.delete(id)) {
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
    let raw: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(target);
      raw = Buffer.from(bytes).toString("utf8");
    } catch {
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
      const message = error instanceof Error ? error.message : String(error);
      if (this.reportedFailure !== message) {
        this.reportedFailure = message;
        void vscode.window.showErrorMessage(`CodeLight could not read ${target.fsPath}. ${message}`);
      }
    }
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
    this.lastSerialized = content;
    this.emitter.fire();
    this.pendingWrite = this.pendingWrite.then(async () => {
      try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, ".."));
        await vscode.workspace.fs.writeFile(target, Buffer.from(content, "utf8"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`CodeLight could not save annotations. ${message}`);
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

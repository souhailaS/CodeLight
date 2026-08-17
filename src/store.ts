import { gunzipSync, gzipSync } from "node:zlib";
import * as vscode from "vscode";
import { Annotation, parseStore, serializeStore } from "./model";
import { readStorageMode } from "./palette";
import { exists, resolveRoot, STORE_PATTERN, storeUri } from "./paths";

const RELOAD_DEBOUNCE_MS = 150;
const MAX_STORE_BYTES = 64 * 1024 * 1024;

type DiskState =
  | {
      status: "ok";
      annotations: Map<string, Annotation>;
      raw: string;
      dropped: number;
      rejected: unknown[];
      source: vscode.Uri;
    }
  | { status: "missing" }
  | { status: "error"; message: string };

interface StoreFiles {
  plain: vscode.Uri;
  compressed: vscode.Uri;
  fresh: vscode.Uri;
}

interface ActiveStore {
  target: vscode.Uri;
  duplicate: boolean;
}

function isMissingFile(error: unknown): boolean {
  if (error instanceof vscode.FileSystemError) {
    return error.code === "FileNotFound";
  }
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCompressed(target: vscode.Uri): boolean {
  return target.path.endsWith(".gz");
}

function decodeStore(bytes: Uint8Array, target: vscode.Uri): string {
  const buffer = Buffer.from(bytes);
  const text = isCompressed(target)
    ? gunzipSync(buffer, { maxOutputLength: MAX_STORE_BYTES }).toString("utf8")
    : buffer.toString("utf8");
  return text.replace(/^\uFEFF/, "");
}

function encodeStore(content: string, target: vscode.Uri): Buffer {
  const buffer = Buffer.from(content, "utf8");
  return isCompressed(target) ? gzipSync(buffer) : buffer;
}

export class AnnotationStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private annotations = new Map<string, Annotation>();
  private root: vscode.Uri | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private lastSerialized: string | undefined;
  private reportedFailure: string | undefined;
  private reportedDropped = 0;
  private reportedDuplicate = false;
  private generation = 0;
  private active: vscode.Uri | undefined;

  readonly onDidChange = this.emitter.event;

  constructor() {
    const discovery = vscode.workspace.createFileSystemWatcher(`**/${STORE_PATTERN}`);
    discovery.onDidCreate(() => void this.bind());
    discovery.onDidDelete(() => void this.bind());
    this.disposables.push(
      discovery,
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
    if (this.active) {
      return this.active;
    }
    return this.root ? storeUri(this.root, readStorageMode(this.root)) : undefined;
  }

  get rootUri(): vscode.Uri | undefined {
    return this.root;
  }

  byId(id: string): Annotation | undefined {
    return this.annotations.get(id);
  }

  forFile(relativePath: string): Annotation[] {
    const matches: Annotation[] = [];
    for (const annotation of this.annotations.values()) {
      if (annotation.file === relativePath) {
        matches.push(annotation);
      }
    }
    return matches;
  }

  async add(annotation: Annotation): Promise<boolean> {
    return this.commit((annotations) => {
      annotations.set(annotation.id, annotation);
      return true;
    });
  }

  async update(id: string, mutate: (annotation: Annotation) => Annotation): Promise<boolean> {
    return this.commit((annotations) => {
      const existing = annotations.get(id);
      if (!existing) {
        return false;
      }
      annotations.set(id, mutate(existing));
      return true;
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.commit((annotations) => annotations.delete(id));
  }

  async transaction(apply: (annotations: Map<string, Annotation>) => boolean): Promise<boolean> {
    return this.commit(apply);
  }

  async refresh(): Promise<void> {
    await this.load();
  }

  async convertStorage(): Promise<boolean> {
    const files = this.snapshot();
    if (!files) {
      void vscode.window.showWarningMessage("CodeLight needs an open folder.");
      return false;
    }
    const generation = this.generation;
    const chosen = await this.enqueue(() => this.pick(files));
    if (generation !== this.generation) {
      return false;
    }
    if (chosen.duplicate) {
      void vscode.window.showWarningMessage(
        `CodeLight found both ${files.plain.fsPath} and ${files.compressed.fsPath}. Remove the one you do not want before converting.`
      );
      return false;
    }
    const source = chosen.target;
    if (!(await exists(source))) {
      void vscode.window.showInformationMessage("CodeLight has no annotation file to convert yet.");
      return false;
    }
    const destination = isCompressed(source) ? files.plain : files.compressed;
    const question = isCompressed(destination)
      ? `Convert ${source.fsPath} into ${destination.fsPath}? The compressed file is much smaller, but git cannot diff or merge it.`
      : `Convert ${source.fsPath} into ${destination.fsPath}? The plain file is larger, and git can diff and merge it again.`;
    const answer = await vscode.window.showWarningMessage(question, { modal: true }, "Convert");
    if (answer !== "Convert") {
      return false;
    }
    if (generation !== this.generation) {
      return false;
    }
    return this.enqueue(async () => {
      if (generation !== this.generation) {
        return false;
      }
      const disk = await this.readDisk(source);
      if (generation !== this.generation) {
        return false;
      }
      if (disk.status === "error") {
        this.reportFailure(disk.message);
        return false;
      }
      if (disk.status === "missing") {
        void vscode.window.showWarningMessage(`CodeLight could not find ${source.fsPath} any more.`);
        return false;
      }
      if (await exists(destination)) {
        void vscode.window.showWarningMessage(
          `CodeLight left ${source.fsPath} alone because ${destination.fsPath} already exists.`
        );
        return false;
      }
      try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(destination, ".."));
        await vscode.workspace.fs.writeFile(destination, encodeStore(disk.raw, destination));
      } catch (error) {
        this.reportFailure(
          `CodeLight could not save annotations to ${destination.fsPath}. ${describe(error)}`
        );
        return false;
      }
      if (!(await this.discard(source))) {
        return false;
      }
      if (generation !== this.generation) {
        return true;
      }
      this.active = destination;
      this.annotations = disk.annotations;
      this.lastSerialized = disk.raw;
      this.reportedFailure = undefined;
      this.emitter.fire();
      void vscode.window.showInformationMessage(`CodeLight now stores annotations in ${destination.fsPath}.`);
      return true;
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private snapshot(): StoreFiles | undefined {
    const root = this.root;
    if (!root) {
      return undefined;
    }
    return {
      plain: storeUri(root, "json"),
      compressed: storeUri(root, "compressed"),
      fresh: storeUri(root, readStorageMode(root))
    };
  }

  private async pick(files: StoreFiles): Promise<ActiveStore> {
    const hasPlain = await exists(files.plain);
    const hasCompressed = await exists(files.compressed);
    if (hasPlain && hasCompressed) {
      return { target: files.plain, duplicate: true };
    }
    if (hasCompressed) {
      return { target: files.compressed, duplicate: false };
    }
    if (hasPlain) {
      return { target: files.plain, duplicate: false };
    }
    return { target: files.fresh, duplicate: false };
  }

  private async commit(apply: (annotations: Map<string, Annotation>) => boolean): Promise<boolean> {
    const files = this.snapshot();
    if (!files) {
      return false;
    }
    const generation = this.generation;
    return this.enqueue(async () => {
      if (generation !== this.generation) {
        return false;
      }
      const chosen = await this.pick(files);
      if (generation !== this.generation) {
        return false;
      }
      this.warnAboutDuplicate(chosen.duplicate, files);
      const target = chosen.target;
      const disk = await this.readDisk(target);
      if (generation !== this.generation) {
        return false;
      }
      if (disk.status === "error") {
        this.reportFailure(disk.message);
        return false;
      }
      const annotations = disk.status === "ok" ? disk.annotations : new Map<string, Annotation>();
      const rejected = disk.status === "ok" ? disk.rejected : [];
      if (!apply(annotations)) {
        return false;
      }
      const content = serializeStore([...annotations.values()], rejected);
      try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, ".."));
        await vscode.workspace.fs.writeFile(target, encodeStore(content, target));
      } catch (error) {
        this.reportFailure(`CodeLight could not save annotations to ${target.fsPath}. ${describe(error)}`);
        this.scheduleReload();
        return false;
      }
      if (generation !== this.generation) {
        return true;
      }
      this.active = target;
      this.annotations = annotations;
      this.lastSerialized = content;
      this.reportedFailure = undefined;
      this.emitter.fire();
      return true;
    });
  }

  private async readDisk(target: vscode.Uri): Promise<DiskState> {
    let raw: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(target);
      raw = decodeStore(bytes, target);
    } catch (error) {
      if (isMissingFile(error)) {
        return { status: "missing" };
      }
      return { status: "error", message: `CodeLight could not read ${target.fsPath}. ${describe(error)}` };
    }
    try {
      const parsed = parseStore(raw);
      return {
        status: "ok",
        raw,
        dropped: parsed.dropped,
        rejected: parsed.rejected,
        annotations: new Map(parsed.annotations.map((entry) => [entry.id, entry])),
        source: target
      };
    } catch (error) {
      return { status: "error", message: `CodeLight could not read ${target.fsPath}. ${describe(error)}` };
    }
  }

  private async bind(): Promise<void> {
    const root = await resolveRoot(this.root);
    if (this.root?.toString() === root?.toString()) {
      if (root) {
        await this.load();
      }
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
    this.active = undefined;
    this.annotations = new Map();
    this.lastSerialized = undefined;
    this.reportedFailure = undefined;
    this.reportedDropped = 0;
    this.reportedDuplicate = false;
    if (!root) {
      this.emitter.fire();
      return;
    }
    const pattern = new vscode.RelativePattern(root, STORE_PATTERN);
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
    const files = this.snapshot();
    if (!files) {
      return;
    }
    const generation = this.generation;
    await this.enqueue(async () => {
      if (generation !== this.generation) {
        return;
      }
      const chosen = await this.pick(files);
      if (generation !== this.generation) {
        return;
      }
      this.warnAboutDuplicate(chosen.duplicate, files);
      const target = chosen.target;
      const disk = await this.readDisk(target);
      if (generation !== this.generation) {
        return;
      }
      if (disk.status === "error") {
        this.reportFailure(disk.message);
        return;
      }
      this.reportedFailure = undefined;
      if (disk.status === "missing") {
        this.active = undefined;
        if (this.annotations.size === 0 && this.lastSerialized === undefined) {
          return;
        }
        this.annotations = new Map();
        this.lastSerialized = undefined;
        this.emitter.fire();
        return;
      }
      if (disk.raw === this.lastSerialized && this.active?.toString() === target.toString()) {
        return;
      }
      this.active = target;
      this.annotations = disk.annotations;
      this.lastSerialized = disk.raw;
      this.warnAboutDropped(disk.dropped, disk.source);
      this.emitter.fire();
    });
  }

  private async discard(previous: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.delete(previous);
    } catch (error) {
      if (isMissingFile(error)) {
        return true;
      }
      this.reportFailure(`CodeLight could not remove ${previous.fsPath}. ${describe(error)}`);
      return false;
    }
    return true;
  }

  private reportFailure(message: string): void {
    if (this.reportedFailure === message) {
      return;
    }
    this.reportedFailure = message;
    void vscode.window.showErrorMessage(message);
  }

  private warnAboutDuplicate(duplicate: boolean, files: StoreFiles): void {
    if (!duplicate || this.reportedDuplicate) {
      return;
    }
    this.reportedDuplicate = true;
    void vscode.window.showWarningMessage(
      `CodeLight found both ${files.plain.fsPath} and ${files.compressed.fsPath}. It is using ${files.plain.fsPath} and leaving the other file alone.`
    );
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

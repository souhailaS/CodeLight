import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import * as vscode from "vscode";
import { inspectTarget, TEMPORARY_NAME, writeThroughTemporary } from "./atomic";
import { mergeSides } from "./conflict";
import { Annotation, hasConflict, parseStore, serializeStore } from "./model";
import { readStorageMode } from "./palette";
import { exists, isMissingFile, statFile, STORE_PATTERN, storeUri } from "./paths";

const RELOAD_DEBOUNCE_MS = 150;
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const LIMIT_MB = MAX_STORE_BYTES / 1024 / 1024;

const compress = promisify(gzip);
const decompress = promisify(gunzip);

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
  | { status: "conflict"; target: vscode.Uri }
  | { status: "error"; message: string };

interface StoreFiles {
  plain: vscode.Uri;
  compressed: vscode.Uri;
  fresh: vscode.Uri;
}

type Duplicate = "yes" | "no" | "unknown";

type Choice =
  | { status: "ok"; target: vscode.Uri; duplicate: Duplicate }
  | { status: "error"; message: string };

type Presence =
  | { status: "ok"; present: boolean; mtime: number }
  | { status: "error"; message: string };

interface State {
  present: boolean;
  mtime: number;
}

interface Outcome {
  target: vscode.Uri;
  duplicate: boolean;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCompressed(target: vscode.Uri): boolean {
  return target.path.endsWith(".gz");
}

async function decodeStore(bytes: Uint8Array, target: vscode.Uri): Promise<string> {
  const buffer = Buffer.from(bytes);
  if (!isCompressed(target) && buffer.byteLength > MAX_STORE_BYTES) {
    throw new Error(`The file is larger than the ${LIMIT_MB} MB limit.`);
  }
  const text = isCompressed(target)
    ? (await decompress(buffer, { maxOutputLength: MAX_STORE_BYTES })).toString("utf8")
    : buffer.toString("utf8");
  return text.replace(/^\uFEFF/, "");
}

const TEMPORARY_AGE_MS = 10 * 60 * 1000;

function tooLarge(content: string): boolean {
  return Buffer.byteLength(content, "utf8") > MAX_STORE_BYTES;
}

async function encodeStore(content: string, target: vscode.Uri): Promise<Buffer> {
  if (tooLarge(content)) {
    throw new Error(
      `The store is larger than the ${LIMIT_MB} MB limit. Remove some annotations before saving again.`
    );
  }
  const buffer = Buffer.from(content, "utf8");
  return isCompressed(target) ? compress(buffer) : buffer;
}

export class FolderStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private annotations = new Map<string, Annotation>();
  private watcher: vscode.FileSystemWatcher | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private lastSerialized: string | undefined;
  private reportedFailure: string | undefined;
  private reportedDropped = 0;
  private reportedDuplicate: string | undefined;
  private reportedInPlace = false;
  private sweeping = false;
  private inConflict = false;
  private generation = 0;
  private active: vscode.Uri | undefined;

  readonly onDidChange = this.emitter.event;

  readonly key: string;

  constructor(private readonly root: vscode.Uri) {
    this.key = root.toString();
  }

  async initialize(): Promise<void> {
    await this.bind();
  }

  get all(): Annotation[] {
    return [...this.annotations.values()];
  }

  get location(): vscode.Uri | undefined {
    return this.active;
  }

  get rootUri(): vscode.Uri {
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
    const generation = this.generation;
    const chosen = await this.enqueue(() => this.pick(files));
    if (generation !== this.generation) {
      return false;
    }
    if (chosen.status === "error") {
      this.reportFailure(chosen.message);
      return false;
    }
    if (chosen.duplicate === "yes") {
      void vscode.window.showWarningMessage(
        `CodeLight found both ${files.plain.fsPath} and ${files.compressed.fsPath}. Remove the one you do not want before converting.`
      );
      return false;
    }
    if (chosen.duplicate === "unknown") {
      void vscode.window.showWarningMessage(
        `CodeLight could not check both annotation files, so it left ${chosen.target.fsPath} alone.`
      );
      return false;
    }
    const source = chosen.target;
    const present = await this.probe(source);
    if (present === undefined) {
      return false;
    }
    if (!present) {
      void vscode.window.showInformationMessage("CodeLight has no annotation file to convert yet.");
      return false;
    }
    const info = await inspectTarget(source);
    if (info?.shared) {
      void vscode.window.showWarningMessage(
        `CodeLight left ${source.fsPath} alone because it is a symlink or has another name pointing at it. Converting it would leave that other name behind.`
      );
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
    const converted = await this.enqueue(async () => {
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
      if (disk.status === "conflict") {
        this.reportConflict(disk.target);
        return false;
      }
      if (disk.status === "missing") {
        void vscode.window.showWarningMessage(`CodeLight could not find ${source.fsPath} any more.`);
        return false;
      }
      const taken = await this.probe(destination);
      if (taken === undefined) {
        return false;
      }
      if (taken) {
        void vscode.window.showWarningMessage(
          `CodeLight left ${source.fsPath} alone because ${destination.fsPath} already exists.`
        );
        return false;
      }
      try {
        await this.writeStore(destination, disk.raw);
      } catch (error) {
        this.reportFailure(
          `CodeLight could not save annotations to ${destination.fsPath}. ${describe(error)}`
        );
        return false;
      }
      const written = await this.readDisk(destination);
      if (written.status !== "ok" || written.raw !== disk.raw) {
        await this.discard(destination);
        this.reportFailure(
          `CodeLight could not read back ${destination.fsPath}, so ${source.fsPath} is left as it was.`
        );
        return false;
      }
      if (!(await this.discard(source))) {
        await this.discard(destination);
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
    return converted;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private snapshot(): StoreFiles {
    const root = this.root;
    return {
      plain: storeUri(root, "json"),
      compressed: storeUri(root, "compressed"),
      fresh: storeUri(root, readStorageMode(root))
    };
  }

  private async inspect(target: vscode.Uri): Promise<Presence> {
    try {
      const stat = await statFile(target);
      return { status: "ok", present: stat !== undefined, mtime: stat ? stat.mtime : 0 };
    } catch (error) {
      return { status: "error", message: `CodeLight could not check ${target.fsPath}. ${describe(error)}` };
    }
  }

  private resolve(files: StoreFiles, plain: State, compressed: State): Outcome {
    if (plain.present && compressed.present) {
      if (plain.mtime > compressed.mtime) {
        return { target: files.plain, duplicate: true };
      }
      return { target: files.compressed, duplicate: true };
    }
    if (compressed.present) {
      return { target: files.compressed, duplicate: false };
    }
    if (plain.present) {
      return { target: files.plain, duplicate: false };
    }
    return { target: this.active ?? files.fresh, duplicate: false };
  }

  private states(presence: Presence): State[] {
    if (presence.status === "ok") {
      return [{ present: presence.present, mtime: presence.mtime }];
    }
    return [
      { present: false, mtime: 0 },
      { present: true, mtime: Number.NEGATIVE_INFINITY }
    ];
  }

  private async pick(files: StoreFiles): Promise<Choice> {
    const plain = await this.inspect(files.plain);
    const compressed = await this.inspect(files.compressed);
    const outcomes: Outcome[] = [];
    for (const plainState of this.states(plain)) {
      for (const compressedState of this.states(compressed)) {
        outcomes.push(this.resolve(files, plainState, compressedState));
      }
    }
    const first = outcomes[0];
    if (outcomes.some((outcome) => outcome.target.toString() !== first.target.toString())) {
      if (plain.status === "error") {
        return { status: "error", message: plain.message };
      }
      if (compressed.status === "error") {
        return { status: "error", message: compressed.message };
      }
    }
    const agreed = outcomes.every((outcome) => outcome.duplicate === first.duplicate);
    if (!agreed) {
      return { status: "ok", target: first.target, duplicate: "unknown" };
    }
    return { status: "ok", target: first.target, duplicate: first.duplicate ? "yes" : "no" };
  }

  private async commit(apply: (annotations: Map<string, Annotation>) => boolean): Promise<boolean> {
    const files = this.snapshot();
    const generation = this.generation;
    return this.enqueue(async () => {
      if (generation !== this.generation) {
        return false;
      }
      const chosen = await this.pick(files);
      if (generation !== this.generation) {
        return false;
      }
      if (chosen.status === "error") {
        this.reportFailure(chosen.message);
        return false;
      }
      this.warnAboutDuplicate(chosen.duplicate, chosen.target, files);
      const target = chosen.target;
      const disk = await this.readDisk(target);
      if (generation !== this.generation) {
        return false;
      }
      if (disk.status === "error") {
        this.reportFailure(disk.message);
        return false;
      }
      if (disk.status === "conflict") {
        this.reportConflict(disk.target);
        return false;
      }
      const annotations = disk.status === "ok" ? disk.annotations : new Map<string, Annotation>();
      const rejected = disk.status === "ok" ? disk.rejected : [];
      const stale =
        disk.status === "ok"
          ? disk.raw !== this.lastSerialized || this.active?.toString() !== target.toString()
          : this.annotations.size > 0 || this.lastSerialized !== undefined;
      if (!apply(annotations)) {
        if (stale) {
          this.scheduleReload();
        }
        return false;
      }
      const content = serializeStore([...annotations.values()], rejected);
      try {
        await this.writeStore(target, content);
      } catch (error) {
        this.reportFailure(`CodeLight could not save annotations to ${target.fsPath}. ${describe(error)}`);
        this.scheduleReload();
        return false;
      }
      if (generation !== this.generation) {
        return true;
      }
      this.active = target;
      this.annotations = new Map([...annotations].map(([id, entry]) => [id, this.tag(entry)]));
      this.lastSerialized = content;
      this.reportedFailure = undefined;
      this.emitter.fire();
      void this.sweep(vscode.Uri.joinPath(target, "..", ".."));
      return true;
    });
  }

  private tag(annotation: Annotation): Annotation {
    return { ...annotation, root: this.key };
  }

  private async readDisk(target: vscode.Uri): Promise<DiskState> {
    let raw: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(target);
      raw = await decodeStore(bytes, target);
    } catch (error) {
      if (isMissingFile(error)) {
        return { status: "missing" };
      }
      return { status: "error", message: `CodeLight could not read ${target.fsPath}. ${describe(error)}` };
    }
    try {
      if (hasConflict(raw)) {
        return { status: "conflict", target };
      }
      const parsed = parseStore(raw);
      return {
        status: "ok",
        raw,
        dropped: parsed.dropped,
        rejected: parsed.rejected,
        annotations: new Map(parsed.annotations.map((entry) => [entry.id, this.tag(entry)])),
        source: target
      };
    } catch (error) {
      return { status: "error", message: `CodeLight could not read ${target.fsPath}. ${describe(error)}` };
    }
  }

  private async bind(): Promise<void> {
    if (this.watcher) {
      await this.load();
      return;
    }
    await this.sweep(this.root);
    const pattern = new vscode.RelativePattern(this.root, STORE_PATTERN);
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
    const generation = this.generation;
    await this.enqueue(async () => {
      if (generation !== this.generation) {
        return;
      }
      const chosen = await this.pick(files);
      if (generation !== this.generation) {
        return;
      }
      if (chosen.status === "error") {
        this.reportFailure(chosen.message);
        return;
      }
      this.warnAboutDuplicate(chosen.duplicate, chosen.target, files);
      const target = chosen.target;
      const disk = await this.readDisk(target);
      if (generation !== this.generation) {
        return;
      }
      if (disk.status === "error") {
        this.reportFailure(disk.message);
        return;
      }
      if (disk.status === "conflict") {
        this.reportConflict(disk.target);
        return;
      }
      this.reportedFailure = undefined;
      const wasStuck = this.inConflict;
      this.clearConflict();
      if (wasStuck) {
        this.emitter.fire();
      }
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

  private async writeStore(target: vscode.Uri, content: string): Promise<void> {
    const bytes = await encodeStore(content, target);
    await writeThroughTemporary(target, bytes, () => this.warnAboutInPlace(target));
  }

  private async probe(target: vscode.Uri): Promise<boolean | undefined> {
    try {
      return await exists(target);
    } catch (error) {
      this.reportFailure(`CodeLight could not check ${target.fsPath}. ${describe(error)}`);
      return undefined;
    }
  }

  private async sweep(root: vscode.Uri): Promise<void> {
    if (this.sweeping) {
      return;
    }
    this.sweeping = true;
    try {
      await this.removeStaleTemporaries(root);
    } finally {
      this.sweeping = false;
    }
  }

  private async removeStaleTemporaries(root: vscode.Uri): Promise<void> {
    await this.removeStaleFrom(root);
    await this.removeStaleFrom(vscode.Uri.joinPath(root, ".vscode"));
  }

  private async removeStaleFrom(folder: vscode.Uri): Promise<void> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(folder);
    } catch {
      return;
    }
    const cutoff = Date.now() - TEMPORARY_AGE_MS;
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !TEMPORARY_NAME.test(name)) {
        continue;
      }
      const candidate = vscode.Uri.joinPath(folder, name);
      let stat: vscode.FileStat;
      try {
        stat = await vscode.workspace.fs.stat(candidate);
      } catch {
        continue;
      }
      if (stat.mtime > cutoff) {
        continue;
      }
      await this.cleanup(candidate);
    }
  }

  private async cleanup(temporary: vscode.Uri): Promise<void> {
    try {
      await vscode.workspace.fs.delete(temporary);
    } catch {
      return;
    }
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

  private clearConflict(): void {
    this.inConflict = false;
  }

  private reportConflict(target: vscode.Uri): void {
    this.inConflict = true;
    this.emitter.fire();
    const message = `CodeLight cannot read ${target.fsPath} because it has an unresolved merge conflict.`;
    if (this.reportedFailure === message) {
      return;
    }
    this.reportedFailure = message;
    void vscode.window
      .showWarningMessage(message, "Merge the notes", "Open the file")
      .then(async (chosen) => {
        if (chosen === "Open the file") {
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
          return;
        }
        if (chosen === "Merge the notes") {
          await vscode.commands.executeCommand("codelight.resolveConflict");
        }
      });
  }

  get conflicted(): boolean {
    return this.inConflict;
  }

  async resolveConflict(): Promise<"merged" | "clean" | "stuck" | "skipped"> {
    const files = this.snapshot();
    const generation = this.generation;
    return this.enqueue(async () => {
      if (generation !== this.generation) {
        return "skipped";
      }
      const chosen = await this.pick(files);
      if (generation !== this.generation) {
        return "skipped";
      }
      if (chosen.status === "error") {
        this.reportFailure(chosen.message);
        return "skipped";
      }
      const target = chosen.target;
      let raw: string;
      try {
        raw = await decodeStore(await vscode.workspace.fs.readFile(target), target);
      } catch (error) {
        if (isMissingFile(error)) {
          return "skipped";
        }
        this.reportFailure(`CodeLight could not read ${target.fsPath}. ${describe(error)}`);
        return "skipped";
      }
      if (!hasConflict(raw)) {
        this.clearConflict();
        return "clean";
      }
      const merged = mergeSides(raw);
      if (!merged) {
        void vscode.window.showWarningMessage(
          `CodeLight could not make sense of the conflict in ${target.fsPath}, so it left the file alone. Resolve it by hand.`
        );
        return "stuck";
      }
      const content = serializeStore(merged.annotations, merged.rejected);
      try {
        await this.writeStore(target, content);
      } catch (error) {
        this.reportFailure(`CodeLight could not save ${target.fsPath}. ${describe(error)}`);
        return "stuck";
      }
      if (generation !== this.generation) {
        return "merged";
      }
      this.clearConflict();
      this.reportedFailure = undefined;
      const gone =
        merged.dropped === 0 ? "" : ` ${merged.dropped} that one side had deleted stayed deleted.`;
      const guess = merged.sawBase
        ? ""
        : " Git left no record of what the file held before, so a note either side deleted is back.";
      void vscode.window.showInformationMessage(
        `CodeLight merged the notes in ${target.fsPath}, ${merged.annotations.length} of them, from the ${merged.mine} on your side and the ${merged.theirs} on theirs.${gone}${guess} Stage the file with git add once you are happy with it.`
      );
      return "merged";
    }).then(async (outcome) => {
      if (outcome === "merged" || outcome === "clean") {
        await this.refresh();
      }
      return outcome;
    });
  }

  private warnAboutInPlace(target: vscode.Uri): void {
    if (this.reportedInPlace) {
      return;
    }
    this.reportedInPlace = true;
    void vscode.window.showWarningMessage(
      `CodeLight saved ${target.fsPath} in place because it cannot create a temporary file beside it. An interrupted save could truncate the store.`
    );
  }

  private warnAboutDuplicate(duplicate: Duplicate, target: vscode.Uri, files: StoreFiles): void {
    if (duplicate === "unknown") {
      return;
    }
    if (duplicate === "no") {
      this.reportedDuplicate = undefined;
      return;
    }
    if (this.reportedDuplicate === target.toString()) {
      return;
    }
    this.reportedDuplicate = target.toString();
    void vscode.window.showWarningMessage(
      `CodeLight found both ${files.plain.fsPath} and ${files.compressed.fsPath}. It is using ${target.fsPath} and leaving the other file alone.`
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
      `CodeLight skipped ${dropped} unreadable ${label} in ${target.fsPath}. They stay in the file, though CodeLight moves them to the end when it saves.`
    );
  }

  dispose(): void {
    this.generation += 1;
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = undefined;
    }
    this.watcher?.dispose();
    this.emitter.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

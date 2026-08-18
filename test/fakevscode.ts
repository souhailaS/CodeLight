import * as fs from "node:fs";
import * as nodePath from "node:path";

export class Uri {
  scheme = "file";
  authority = "";
  query = "";
  fragment = "";
  constructor(public path: string) {}
  get fsPath(): string {
    return this.path;
  }
  toString(): string {
    return `file://${this.path}`;
  }
  toJSON(): unknown {
    return { scheme: this.scheme, path: this.path };
  }
  with(change: { scheme?: string; authority?: string; path?: string }): Uri {
    const next = new Uri(change.path ?? this.path);
    next.scheme = change.scheme ?? this.scheme;
    next.authority = change.authority ?? this.authority;
    return next;
  }
  static file(value: string): Uri {
    return new Uri(value);
  }
  static parse(value: string): Uri {
    return new Uri(value);
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(nodePath.resolve(base.path, ...segments));
  }
}

export class FileSystemError extends Error {
  code = "Unknown";

  static FileNotFound(target?: Uri): FileSystemError {
    const error = new FileSystemError(`file not found ${target?.fsPath ?? ""}`.trim());
    error.code = "FileNotFound";
    return error;
  }

  static NoPermissions(target?: Uri): FileSystemError {
    const error = new FileSystemError(`no permissions ${target?.fsPath ?? ""}`.trim());
    error.code = "NoPermissions";
    return error;
  }

  static FileIsADirectory(target?: Uri): FileSystemError {
    const error = new FileSystemError(`file is a directory ${target?.fsPath ?? ""}`.trim());
    error.code = "FileIsADirectory";
    return error;
  }

  static FileNotADirectory(target?: Uri): FileSystemError {
    const error = new FileSystemError(`file is not a directory ${target?.fsPath ?? ""}`.trim());
    error.code = "FileNotADirectory";
    return error;
  }

  static FileExists(target?: Uri): FileSystemError {
    const error = new FileSystemError(`file exists ${target?.fsPath ?? ""}`.trim());
    error.code = "FileExists";
    return error;
  }
}

export class EventEmitter<T> {
  private listeners: Array<(value: T) => void> = [];
  event = (listener: (value: T) => void) => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const at = this.listeners.indexOf(listener);
        if (at >= 0) {
          this.listeners.splice(at, 1);
        }
      }
    };
  };
  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }
  dispose(): void {
    this.listeners = [];
  }
}

export class RelativePattern {
  constructor(
    public base: Uri,
    public pattern: string
  ) {}
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64
}

const configuration = new Map<string, unknown>();

const answers: string[] = [];

export const messages: string[] = [];

export const faults = {
  corruptTemp: false,
  deletePath: undefined as string | undefined,
  statPath: undefined as string | undefined,
  statSkip: 0,
  interruptWrite: false,
  writeCode: undefined as string | undefined,
  errorShape: "vscode" as "vscode" | "node"
};

function raise(error: unknown, target: Uri): never {
  if (faults.errorShape === "node") {
    throw error;
  }
  const code = typeof error === "object" && error !== null ? (error as { code?: string }).code : undefined;
  if (code === "ENOENT") {
    throw FileSystemError.FileNotFound(target);
  }
  if (code === "EACCES" || code === "EPERM") {
    throw FileSystemError.NoPermissions(target);
  }
  if (code === "EISDIR") {
    throw FileSystemError.FileIsADirectory(target);
  }
  if (code === "ENOTDIR") {
    throw FileSystemError.FileNotADirectory(target);
  }
  if (code === "EEXIST") {
    throw FileSystemError.FileExists(target);
  }
  const unknown = new FileSystemError(error instanceof Error ? error.message : String(error));
  throw unknown;
}

export function setConfiguration(key: string, value: unknown): void {
  configuration.set(key, value);
}

export function setFolderConfiguration(root: Uri, key: string, value: unknown): void {
  configuration.set(`${key}@${root.path}`, value);
}

export function queueAnswer(answer: string): void {
  answers.push(answer);
}

export function clearFaults(): void {
  faults.errorShape = "vscode";
  faults.writeCode = undefined;
  faults.corruptTemp = false;
  faults.deletePath = undefined;
  faults.statPath = undefined;
  faults.statSkip = 0;
  faults.interruptWrite = false;
}

export function warnings(): string[] {
  return messages.filter((entry) => entry.startsWith("warning "));
}

export function errors(): string[] {
  return messages.filter((entry) => entry.startsWith("error "));
}

export const window = {
  activeTextEditor: undefined as unknown,
  showErrorMessage(message: string) {
    messages.push(`error ${message}`);
    return Promise.resolve(undefined);
  },
  showInformationMessage(message: string, ...rest: unknown[]) {
    messages.push(`info ${message}`);
    if (rest.length === 0) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(answers.shift());
  },
  showWarningMessage(message: string, ...rest: unknown[]) {
    messages.push(`warning ${message}`);
    if (rest.length === 0) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(answers.shift());
  },
  showTextDocument(document: unknown) {
    opened.push(document as { uri: Uri });
    return Promise.resolve(undefined);
  },
  visibleTextEditors: [] as Array<{ document: unknown }>,
  onDidChangeVisibleTextEditors() {
    return { dispose: () => undefined };
  },
  createTextEditorDecorationType(options: unknown) {
    const type: Decoration = {
      options,
      disposed: false,
      dispose(): void {
        type.disposed = true;
      }
    };
    decorations.push(type);
    return type;
  }
};

export interface Decoration {
  options: unknown;
  disposed: boolean;
  dispose(): void;
}

export const decorations: Decoration[] = [];

export class ThemeColor {
  constructor(public id: string) {}
}

export enum DecorationRangeBehavior {
  OpenOpen = 0,
  ClosedClosed = 1
}

export enum OverviewRulerLane {
  Left = 1,
  Center = 2,
  Right = 4,
  Full = 7
}

export const opened: Array<{ uri: Uri }> = [];

export const commands = {
  executeCommand(...rest: unknown[]) {
    invoked.push(rest);
    return Promise.resolve(undefined);
  }
};

export const invoked: unknown[][] = [];

export interface Watcher {
  pattern: unknown;
  disposed: boolean;
  created: EventEmitter<Uri>;
  changed: EventEmitter<Uri>;
  deleted: EventEmitter<Uri>;
}

export const watchers: Watcher[] = [];

export function live(): Watcher[] {
  return watchers.filter((watcher) => !watcher.disposed);
}

export function announce(kind: "created" | "changed" | "deleted", target: Uri): void {
  for (const watcher of live()) {
    watcher[kind].fire(target);
  }
}

export const workspace = {
  workspaceFolders: [] as Array<{ uri: Uri; name: string; index: number }>,
  textDocuments: [] as Array<{ uri: Uri; isDirty: boolean }>,
  fs: {
    async readFile(target: Uri): Promise<Uint8Array> {
      try {
        return await fs.promises.readFile(target.path);
      } catch (error) {
        raise(error, target);
      }
    },
    async writeFile(target: Uri, bytes: Uint8Array): Promise<void> {
      if (faults.writeCode !== undefined && /codelight\.write-.+\.tmp$/.test(target.path)) {
        raise(Object.assign(new Error(`${faults.writeCode} write failed`), { code: faults.writeCode }), target);
      }
      if (faults.corruptTemp && /codelight\.write-.+\.tmp$/.test(target.path)) {
        await fs.promises.writeFile(target.path, Buffer.from("corrupted on the way to disk", "utf8"));
        return;
      }
      if (faults.interruptWrite) {
        await fs.promises.writeFile(target.path, Buffer.from(bytes).subarray(0, Math.floor(bytes.length / 2)));
        raise(Object.assign(new Error("EIO write interrupted"), { code: "EIO" }), target);
      }
      try {
        await fs.promises.writeFile(target.path, bytes);
      } catch (error) {
        raise(error, target);
      }
    },
    async createDirectory(target: Uri): Promise<void> {
      try {
        await fs.promises.mkdir(target.path, { recursive: true });
      } catch (error) {
        raise(error, target);
      }
    },
    async delete(target: Uri): Promise<void> {
      if (target.path === faults.deletePath) {
        raise(Object.assign(new Error("EPERM operation not permitted"), { code: "EPERM" }), target);
      }
      try {
        await fs.promises.rm(target.path);
      } catch (error) {
        raise(error, target);
      }
    },
    async stat(target: Uri): Promise<{ size: number; mtime: number; ctime: number; type: FileType }> {
      if (target.path === faults.statPath) {
        if (faults.statSkip > 0) {
          faults.statSkip -= 1;
        } else {
          raise(Object.assign(new Error("EIO stat failed"), { code: "EIO" }), target);
        }
      }
      try {
        const info = await fs.promises.stat(target.path);
        return {
          size: info.size,
          mtime: info.mtimeMs,
          ctime: info.ctimeMs,
          type: info.isDirectory() ? FileType.Directory : FileType.File
        };
      } catch (error) {
        raise(error, target);
      }
    },
    async readDirectory(target: Uri): Promise<Array<[string, FileType]>> {
      try {
        const found = await fs.promises.readdir(target.path, { withFileTypes: true });
        return found.map((entry): [string, FileType] => [
          entry.name,
          entry.isDirectory() ? FileType.Directory : FileType.File
        ]);
      } catch (error) {
        raise(error, target);
      }
    }
  },
  getConfiguration(section: string, resource?: Uri | null) {
    return {
      get<T>(key: string): T | undefined {
        const scoped = resource ? configuration.get(`${section}.${key}@${resource.path}`) : undefined;
        return (scoped ?? configuration.get(`${section}.${key}`)) as T | undefined;
      }
    };
  },
  onDidChangeConfiguration() {
    return { dispose: () => undefined };
  },
  onDidOpenTextDocument() {
    return { dispose: () => undefined };
  },
  onDidChangeTextDocument() {
    return { dispose: () => undefined };
  },
  onDidSaveTextDocument() {
    return { dispose: () => undefined };
  },
  onDidCloseTextDocument() {
    return { dispose: () => undefined };
  },
  getWorkspaceFolder(target: Uri): { uri: Uri; name: string; index: number } | undefined {
    return workspace.workspaceFolders.find((folder) => target.path.startsWith(folder.uri.path));
  },
  createFileSystemWatcher(pattern?: unknown) {
    const watcher: Watcher = {
      pattern,
      disposed: false,
      created: new EventEmitter<Uri>(),
      changed: new EventEmitter<Uri>(),
      deleted: new EventEmitter<Uri>()
    };
    watchers.push(watcher);
    return {
      onDidCreate: watcher.created.event,
      onDidChange: watcher.changed.event,
      onDidDelete: watcher.deleted.event,
      dispose: () => {
        watcher.disposed = true;
      }
    };
  },
  onDidChangeWorkspaceFolders() {
    return { dispose: () => undefined };
  },
  openTextDocument(target: Uri) {
    return Promise.resolve({ uri: target });
  }
};

export function resetFake(): void {
  clearFaults();
  configuration.clear();
  answers.length = 0;
  messages.length = 0;
  workspace.workspaceFolders = [];
  workspace.textDocuments = [];
  watchers.length = 0;
  window.activeTextEditor = undefined;
  window.visibleTextEditors = [];
  opened.length = 0;
  decorations.length = 0;
  invoked.length = 0;
}

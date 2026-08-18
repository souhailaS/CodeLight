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
}

export class EventEmitter<T> {
  private listeners: Array<(value: T) => void> = [];
  event = (listener: (value: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => undefined };
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
  interruptWrite: false
};

export function setConfiguration(key: string, value: unknown): void {
  configuration.set(key, value);
}

export function queueAnswer(answer: string): void {
  answers.push(answer);
}

export function clearFaults(): void {
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
  }
};

export const opened: Array<{ uri: Uri }> = [];

export const workspace = {
  workspaceFolders: [] as Array<{ uri: Uri; name: string; index: number }>,
  textDocuments: [] as Array<{ uri: Uri; isDirty: boolean }>,
  fs: {
    async readFile(target: Uri): Promise<Uint8Array> {
      return fs.promises.readFile(target.path);
    },
    async writeFile(target: Uri, bytes: Uint8Array): Promise<void> {
      if (faults.corruptTemp && /codelight\.write-.+\.tmp$/.test(target.path)) {
        await fs.promises.writeFile(target.path, Buffer.from("corrupted on the way to disk", "utf8"));
        return;
      }
      if (faults.interruptWrite) {
        await fs.promises.writeFile(target.path, Buffer.from(bytes).subarray(0, Math.floor(bytes.length / 2)));
        throw Object.assign(new Error("EIO write interrupted"), { code: "EIO" });
      }
      await fs.promises.writeFile(target.path, bytes);
    },
    async createDirectory(target: Uri): Promise<void> {
      await fs.promises.mkdir(target.path, { recursive: true });
    },
    async delete(target: Uri): Promise<void> {
      if (target.path === faults.deletePath) {
        throw Object.assign(new Error("EPERM operation not permitted"), { code: "EPERM" });
      }
      await fs.promises.rm(target.path);
    },
    async stat(target: Uri): Promise<{ size: number; mtime: number; ctime: number; type: FileType }> {
      if (target.path === faults.statPath) {
        if (faults.statSkip > 0) {
          faults.statSkip -= 1;
        } else {
          throw Object.assign(new Error("EIO stat failed"), { code: "EIO" });
        }
      }
      const info = await fs.promises.stat(target.path);
      return {
        size: info.size,
        mtime: info.mtimeMs,
        ctime: info.ctimeMs,
        type: info.isDirectory() ? FileType.Directory : FileType.File
      };
    },
    async readDirectory(target: Uri): Promise<Array<[string, FileType]>> {
      const found = await fs.promises.readdir(target.path, { withFileTypes: true });
      return found.map((entry): [string, FileType] => [
        entry.name,
        entry.isDirectory() ? FileType.Directory : FileType.File
      ]);
    }
  },
  getConfiguration(section: string) {
    return {
      get<T>(key: string): T | undefined {
        return configuration.get(`${section}.${key}`) as T | undefined;
      }
    };
  },
  getWorkspaceFolder(target: Uri): { uri: Uri; name: string; index: number } | undefined {
    return workspace.workspaceFolders.find((folder) => target.path.startsWith(folder.uri.path));
  },
  createFileSystemWatcher() {
    return {
      onDidCreate: () => ({ dispose: () => undefined }),
      onDidChange: () => ({ dispose: () => undefined }),
      onDidDelete: () => ({ dispose: () => undefined }),
      dispose: () => undefined
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
  window.activeTextEditor = undefined;
  opened.length = 0;
}

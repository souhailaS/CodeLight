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

export class Position {
  constructor(
    public line: number,
    public character: number
  ) {}
  isEqual(other: Position): boolean {
    return this.line === other.line && this.character === other.character;
  }
  isBefore(other: Position): boolean {
    return this.line < other.line || (this.line === other.line && this.character < other.character);
  }
  isBeforeOrEqual(other: Position): boolean {
    return this.isBefore(other) || this.isEqual(other);
  }
  isAfter(other: Position): boolean {
    return other.isBefore(this);
  }
  isAfterOrEqual(other: Position): boolean {
    return this.isAfter(other) || this.isEqual(other);
  }
  compareTo(other: Position): number {
    if (this.isBefore(other)) {
      return -1;
    }
    return this.isEqual(other) ? 0 : 1;
  }
  translate(lines?: number | { lineDelta?: number; characterDelta?: number }, characters?: number): Position {
    if (typeof lines === "object") {
      return new Position(
        this.line + (lines.lineDelta ?? 0),
        this.character + (lines.characterDelta ?? 0)
      );
    }
    return new Position(this.line + (lines ?? 0), this.character + (characters ?? 0));
  }
  with(line?: number | { line?: number; character?: number }, character?: number): Position {
    if (typeof line === "object") {
      return new Position(line.line ?? this.line, line.character ?? this.character);
    }
    return new Position(line ?? this.line, character ?? this.character);
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(
    startLine: number | Position,
    startCharacter: number | Position,
    endLine?: number,
    endCharacter?: number
  ) {
    if (startLine instanceof Position && startCharacter instanceof Position) {
      this.start = startLine;
      this.end = startCharacter;
      return;
    }
    this.start = new Position(startLine as number, startCharacter as number);
    this.end = new Position(endLine ?? 0, endCharacter ?? 0);
  }
  get isEmpty(): boolean {
    return this.start.isEqual(this.end);
  }
  get isSingleLine(): boolean {
    return this.start.line === this.end.line;
  }
  isEqual(other: Range): boolean {
    return this.start.isEqual(other.start) && this.end.isEqual(other.end);
  }
  contains(other: Position | Range): boolean {
    const from = other instanceof Range ? other.start : other;
    const to = other instanceof Range ? other.end : other;
    return this.start.isBeforeOrEqual(from) && this.end.isAfterOrEqual(to);
  }
  intersection(other: Range): Range | undefined {
    const start = this.start.isAfter(other.start) ? this.start : other.start;
    const end = this.end.isBefore(other.end) ? this.end : other.end;
    return start.isAfter(end) ? undefined : new Range(start, end);
  }
  union(other: Range): Range {
    const start = this.start.isBefore(other.start) ? this.start : other.start;
    const end = this.end.isAfter(other.end) ? this.end : other.end;
    return new Range(start, end);
  }
  with(start?: Position | { start?: Position; end?: Position }, end?: Position): Range {
    if (start && !(start instanceof Position)) {
      return new Range(start.start ?? this.start, start.end ?? this.end);
    }
    return new Range(start ?? this.start, end ?? this.end);
  }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2
}

export class TreeItem {
  description?: string;
  contextValue?: string;
  iconPath?: unknown;
  id?: string;
  tooltip?: string;
  resourceUri?: Uri;
  command?: { command: string; title: string; arguments?: unknown[] };
  constructor(
    public label: string,
    public collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None
  ) {}
}

export class ThemeIcon {
  static readonly File = new ThemeIcon("file");
  static readonly Folder = new ThemeIcon("folder");
  constructor(
    public id: string,
    public color?: ThemeColor
  ) {}
}

export class MarkdownString {
  value: string;
  isTrusted = false;
  supportHtml = false;
  supportThemeIcons = false;

  constructor(value = "") {
    this.value = value;
  }
  appendMarkdown(value: string): MarkdownString {
    this.value += value;
    return this;
  }
  appendText(value: string): MarkdownString {
    this.value += value;
    return this;
  }
}

export class RelativePattern {
  constructor(
    public base: Uri,
    public pattern: string
  ) {}
}

export enum EndOfLine {
  LF = 1,
  CRLF = 2
}

export class TextDocument {
  version = 1;
  isDirty = false;
  isClosed = false;
  isUntitled = false;
  languageId = "typescript";
  encoding = "utf8";
  notebook = undefined;
  eol: EndOfLine = EndOfLine.LF;

  get fileName(): string {
    return this.uri.fsPath;
  }

  constructor(
    public uri: Uri,
    private body: string
  ) {}

  get text(): string {
    return this.body;
  }

  get lineCount(): number {
    return this.body.split("\n").length;
  }

  getText(): string {
    return this.body;
  }

  offsetAt(position: Position): number {
    const lines = this.body.split("\n");
    if (position.line >= lines.length) {
      return this.body.length;
    }
    let offset = 0;
    for (let line = 0; line < position.line; line += 1) {
      offset += lines[line].length + 1;
    }
    const width = lines[position.line]?.length ?? 0;
    return offset + Math.max(0, Math.min(position.character, width));
  }

  positionAt(offset: number): Position {
    const lines = this.body.split("\n");
    let left = Math.max(0, Math.min(offset, this.body.length));
    for (let line = 0; line < lines.length; line += 1) {
      if (left <= lines[line].length) {
        return new Position(line, left);
      }
      left -= lines[line].length + 1;
    }
    return new Position(lines.length - 1, 0);
  }

  lineAt(at: number | Position): {
    lineNumber: number;
    text: string;
    range: Range;
    rangeIncludingLineBreak: Range;
    firstNonWhitespaceCharacterIndex: number;
    isEmptyOrWhitespace: boolean;
  } {
    const line = typeof at === "number" ? at : at.line;
    const lines = this.body.split("\n");
    const text = lines[line] ?? "";
    const last = line >= lines.length - 1;
    return {
      lineNumber: line,
      text,
      range: new Range(line, 0, line, text.length),
      rangeIncludingLineBreak: last
        ? new Range(line, 0, line, text.length)
        : new Range(line, 0, line + 1, 0),
      firstNonWhitespaceCharacterIndex: text.length - text.trimStart().length,
      isEmptyOrWhitespace: text.trim() === ""
    };
  }

  validateRange(range: Range): Range {
    return range;
  }

  validatePosition(position: Position): Position {
    return this.positionAt(this.offsetAt(position));
  }

  getWordRangeAtPosition(position: Position): Range | undefined {
    void position;
    return undefined;
  }

  replace(start: number, length: number, text: string): void {
    const before = this.body.slice(0, start);
    const after = this.body.slice(start + length);
    const range = new Range(this.positionAt(start), this.positionAt(start + length));
    this.body = `${before}${text}${after}`;
    this.version += 1;
    this.isDirty = true;
    documentChanged.fire({
      document: this,
      contentChanges: [{ range, rangeOffset: start, rangeLength: length, text }]
    });
  }

  edit(changes: Array<{ start: number; length: number; text: string }>): void {
    const ordered = [...changes].sort((a, b) => b.start - a.start);
    const events = ordered.map((change) => ({
      range: new Range(this.positionAt(change.start), this.positionAt(change.start + change.length)),
      rangeOffset: change.start,
      rangeLength: change.length,
      text: change.text
    }));
    for (const change of ordered) {
      this.body = `${this.body.slice(0, change.start)}${change.text}${this.body.slice(change.start + change.length)}`;
    }
    this.version += 1;
    this.isDirty = true;
    documentChanged.fire({ document: this, contentChanges: events });
  }

  useCrlf(): void {
    this.body = this.body.replace(/\n/g, "\r\n");
    this.eol = EndOfLine.CRLF;
    this.version += 1;
    this.isDirty = true;
    documentChanged.fire({ document: this, contentChanges: [] });
  }

  async save(): Promise<boolean> {
    this.isDirty = false;
    await Promise.resolve();
    documentSaved.fire(this);
    return true;
  }
}

export const documentOpened = new EventEmitter<TextDocument>();
export const documentChanged = new EventEmitter<{
  document: TextDocument;
  contentChanges: Array<{ range: Range; rangeOffset: number; rangeLength: number; text: string }>;
}>();
export const documentSaved = new EventEmitter<TextDocument>();
export const documentClosed = new EventEmitter<TextDocument>();

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
  writeDelayMs: 0,
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
  faults.writeDelayMs = 0;
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

export const editorSelectionChanged = new EventEmitter<{
  textEditor: unknown;
  selections: unknown[];
  kind: number | undefined;
}>();
export const activeEditorChanged = new EventEmitter<unknown>();

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
    for (const entry of rest) {
      const text = (entry as { detail?: unknown })?.detail;
      if (typeof text === "string") {
        details.push(text);
      }
    }
    if (rest.length === 0) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(answers.shift());
  },
  showTextDocument(document: unknown) {
    opened.push(document as { uri: Uri });
    const editor = {
      document,
      selection: new Selection(new Position(0, 0), new Position(0, 0)),
      selections: [new Selection(new Position(0, 0), new Position(0, 0))],
      revealRange(): void {
        return undefined;
      },
      setDecorations(): void {
        return undefined;
      }
    };
    shown.push(editor);
    return Promise.resolve(editor);
  },
  showInputBox(options?: { value?: string }) {
    inputs.push(options);
    const answer = typed.shift();
    return Promise.resolve(answer);
  },
  visibleTextEditors: [] as Editor[],
  onDidChangeVisibleTextEditors() {
    return { dispose: () => undefined };
  },
  createStatusBarItem(alignment?: StatusBarAlignment, priority?: number) {
    void alignment;
    void priority;
    const item: StatusBar = {
      text: "",
      tooltip: "",
      command: undefined,
      visible: false,
      disposed: false,
      show(): void {
        item.visible = true;
      },
      hide(): void {
        item.visible = false;
      },
      dispose(): void {
        item.disposed = true;
      }
    };
    statusBars.push(item);
    return item;
  },
  setStatusBarMessage(message: string) {
    messages.push(`status ${message}`);
    return { dispose: () => undefined };
  },
  showQuickPick(items: unknown[], options?: unknown) {
    picks.push({ items, options });
    const at = chosen.shift();
    return Promise.resolve(at === undefined ? undefined : (items as unknown[])[at]);
  },
  onDidChangeTextEditorSelection: editorSelectionChanged.event,
  onDidChangeActiveTextEditor: activeEditorChanged.event,
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

export interface Editor {
  document: unknown;
  applied: Map<Decoration, unknown[]>;
  setDecorations(type: Decoration, ranges: unknown[]): void;
}

export function editorFor(document: unknown): Editor {
  const editor: Editor = {
    document,
    applied: new Map(),
    setDecorations(type: Decoration, ranges: unknown[]): void {
      editor.applied.set(type, ranges);
    }
  };
  return editor;
}

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

export const details: string[] = [];
export const shown: unknown[] = [];
export const inputs: unknown[] = [];
const typed: Array<string | undefined> = [];

export function queueInput(value: string | undefined): void {
  typed.push(value);
}

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

export enum StatusBarAlignment {
  Left = 1,
  Right = 2
}

export interface StatusBar {
  text: string;
  tooltip: string;
  command: string | undefined;
  visible: boolean;
  disposed: boolean;
  show(): void;
  hide(): void;
  dispose(): void;
}

export const statusBars: StatusBar[] = [];

export const picks: Array<{ items: unknown[]; options: unknown }> = [];

const chosen: Array<number | undefined> = [];

export function queuePick(index: number | undefined): void {
  chosen.push(index);
}

export enum TextEditorSelectionChangeKind {
  Keyboard = 1,
  Mouse = 2,
  Command = 3
}

export const authentication = {
  session: undefined as { account: { label: string; id: string }; accessToken: string } | undefined,
  getSession(_provider: string, _scopes: string[], options?: { createIfNone?: boolean }) {
    if (!authentication.session && options?.createIfNone !== true) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(authentication.session);
  },
  onDidChangeSessions() {
    return { dispose: () => undefined };
  }
};

export const workspace = {
  workspaceFolders: [] as Array<{ uri: Uri; name: string; index: number }>,
  textDocuments: [] as TextDocument[],
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
      if (faults.writeDelayMs > 0) {
        await new Promise((done) => setTimeout(done, faults.writeDelayMs));
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
        const prefix = `${section}.${key}@`;
        let best: unknown;
        let longest = -1;
        if (resource) {
          for (const [stored, value] of configuration) {
            if (!stored.startsWith(prefix)) {
              continue;
            }
            const folder = stored.slice(prefix.length);
            const inside = resource.path === folder || resource.path.startsWith(`${folder}/`);
            if (inside && folder.length > longest) {
              best = value;
              longest = folder.length;
            }
          }
        }
        return (longest >= 0 ? best : configuration.get(`${section}.${key}`)) as T | undefined;
      }
    };
  },
  onDidChangeConfiguration() {
    return { dispose: () => undefined };
  },
  onDidOpenTextDocument: documentOpened.event,
  onDidChangeTextDocument: documentChanged.event,
  onDidSaveTextDocument: documentSaved.event,
  onDidCloseTextDocument: documentClosed.event,
  getWorkspaceFolder(target: Uri): { uri: Uri; name: string; index: number } | undefined {
    let best: { uri: Uri; name: string; index: number } | undefined;
    for (const folder of workspace.workspaceFolders) {
      const inside = target.path === folder.uri.path || target.path.startsWith(`${folder.uri.path}/`);
      if (inside && (!best || folder.uri.path.length > best.uri.path.length)) {
        best = folder;
      }
    }
    return best;
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
    const found = workspace.textDocuments.find((entry) => entry.uri.toString() === target.toString());
    return Promise.resolve(found ?? { uri: target });
  }
};

export function resetFake(): void {
  clearFaults();
  configuration.clear();
  answers.length = 0;
  messages.length = 0;
  workspace.workspaceFolders = [];
  workspace.textDocuments = [];
  documentOpened.dispose();
  documentChanged.dispose();
  documentSaved.dispose();
  documentClosed.dispose();
  watchers.length = 0;
  window.activeTextEditor = undefined;
  window.visibleTextEditors = [];
  opened.length = 0;
  details.length = 0;
  shown.length = 0;
  inputs.length = 0;
  typed.length = 0;
  decorations.length = 0;
  invoked.length = 0;
  statusBars.length = 0;
  controllers.length = 0;
  clipboard.text = "";
  clipboard.failWrite = false;
  picks.length = 0;
  chosen.length = 0;
  authentication.session = undefined;
  editorSelectionChanged.dispose();
  activeEditorChanged.dispose();
}

export enum CommentMode {
  Editing = 0,
  Preview = 1
}

export enum CommentThreadCollapsibleState {
  Collapsed = 0,
  Expanded = 1
}

export enum CommentThreadState {
  Unresolved = 0,
  Resolved = 1
}

export enum TextEditorRevealType {
  Default = 0,
  InCenter = 1,
  InCenterIfOutsideViewport = 2,
  AtTop = 3
}

export class Selection extends Range {
  constructor(anchor: Position | number, active: Position | number, endLine?: number, endCharacter?: number) {
    super(anchor as never, active as never, endLine, endCharacter);
  }
  get anchor(): Position {
    return this.start;
  }
  get active(): Position {
    return this.end;
  }
}

export interface FakeCommentThread {
  uri: Uri;
  range: Range | undefined;
  comments: unknown[];
  label?: string;
  contextValue?: string;
  collapsibleState?: CommentThreadCollapsibleState;
  disposed: boolean;
  dispose(): void;
}

export interface FakeCommentController {
  id: string;
  label: string;
  options: unknown;
  commentingRangeProvider: unknown;
  threads: FakeCommentThread[];
  disposed: boolean;
  createCommentThread(uri: Uri, range: Range, comments: unknown[]): FakeCommentThread;
  dispose(): void;
}

export const controllers: FakeCommentController[] = [];

export const comments = {
  createCommentController(id: string, label: string): FakeCommentController {
    const controller: FakeCommentController = {
      id,
      label,
      options: undefined,
      commentingRangeProvider: undefined,
      threads: [],
      disposed: false,
      createCommentThread(uri: Uri, range: Range, list: unknown[]): FakeCommentThread {
        const thread: FakeCommentThread = {
          uri,
          range,
          comments: list,
          disposed: false,
          dispose(): void {
            thread.disposed = true;
          }
        };
        controller.threads.push(thread);
        return thread;
      },
      dispose(): void {
        controller.disposed = true;
      }
    };
    controllers.push(controller);
    return controller;
  }
};

export const clipboard = { text: "", failWrite: false };

export const env = {
  clipboard: {
    writeText(value: string): Promise<void> {
      if (clipboard.failWrite) {
        return Promise.reject(new Error("clipboard unavailable"));
      }
      clipboard.text = value;
      return Promise.resolve();
    },
    readText(): Promise<string> {
      return Promise.resolve(clipboard.text);
    }
  }
};

export function resetComments(): void {
  controllers.length = 0;
  clipboard.text = "";
  clipboard.failWrite = false;
}

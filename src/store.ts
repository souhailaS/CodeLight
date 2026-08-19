import * as vscode from "vscode";
import { FolderStore } from "./folderstore";
import { Annotation } from "./model";
import { pathLabel, toRelativePath, toUri } from "./paths";

export { FolderStore } from "./folderstore";

export class AnnotationStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly stores = new Map<string, FolderStore>();
  private readonly links = new Map<string, vscode.Disposable>();

  readonly onDidChange = this.emitter.event;

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.sync();
      })
    );
  }

  async initialize(): Promise<void> {
    await this.sync();
    this.tellAboutConflicts();
  }

  get isReady(): boolean {
    return this.stores.size > 0;
  }

  get folders(): FolderStore[] {
    const ordered: FolderStore[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const store = this.stores.get(folder.uri.toString());
      if (store) {
        ordered.push(store);
      }
    }
    for (const store of this.stores.values()) {
      if (!ordered.includes(store)) {
        ordered.push(store);
      }
    }
    return ordered;
  }

  get all(): Annotation[] {
    return this.folders.flatMap((store) => store.all);
  }

  get location(): vscode.Uri | undefined {
    const folders = this.folders;
    return folders.length === 1 ? folders[0].location : undefined;
  }

  get rootUri(): vscode.Uri | undefined {
    const folders = this.folders;
    return folders.length === 1 ? folders[0].rootUri : undefined;
  }

  folderFor(target: vscode.Uri): FolderStore | undefined {
    let best: FolderStore | undefined;
    let longest = -1;
    for (const store of this.folders) {
      const relative = toRelativePath(store.rootUri, target);
      if (relative === undefined) {
        continue;
      }
      const depth = store.rootUri.path.length;
      if (depth > longest) {
        best = store;
        longest = depth;
      }
    }
    return best;
  }

  label(root: string | undefined, detail: string): string {
    if (this.stores.size < 2 || root === undefined) {
      return detail;
    }
    const store = this.stores.get(root);
    if (!store) {
      return detail;
    }
    const name = this.nameOf(store);
    return detail === "" ? name : `${name} · ${detail}`;
  }

  private trail(store: FolderStore, depth: number): string {
    const parts = store.rootUri.path.split("/").filter((part) => part !== "");
    return parts.slice(Math.max(0, parts.length - depth)).join("/");
  }

  private nameOf(store: FolderStore): string {
    const parts = store.rootUri.path.split("/").filter((part) => part !== "");
    const own = parts[parts.length - 1] ?? store.rootUri.toString();
    const name = vscode.workspace.getWorkspaceFolder(store.rootUri)?.name ?? own;
    const shared = this.folders.some(
      (other) =>
        other.key !== store.key &&
        (vscode.workspace.getWorkspaceFolder(other.rootUri)?.name ??
          other.rootUri.path.split("/").filter((part) => part !== "").pop()) === name
    );
    if (!shared) {
      return name;
    }
    for (let depth = 2; depth <= parts.length; depth += 1) {
      const longer = parts.slice(parts.length - depth).join("/");
      const still = this.folders.some(
        (other) => other.key !== store.key && this.trail(other, depth) === longer
      );
      if (!still) {
        return longer;
      }
    }
    return pathLabel(store.rootUri);
  }

  rootFor(target: vscode.Uri): vscode.Uri | undefined {
    return this.folderFor(target)?.rootUri;
  }

  relative(target: vscode.Uri): string | undefined {
    const store = this.folderFor(target);
    return store ? toRelativePath(store.rootUri, target) : undefined;
  }

  uriFor(annotation: Annotation): vscode.Uri | undefined {
    const store = this.storeOf(annotation);
    return store ? toUri(store.rootUri, annotation.file) : undefined;
  }

  holdersOf(id: string): FolderStore[] {
    return this.folders.filter((store) => store.byId(id) !== undefined);
  }

  byId(id: string): Annotation | undefined {
    for (const store of this.folders) {
      const found = store.byId(id);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  forFile(target: vscode.Uri): Annotation[] {
    const found: Annotation[] = [];
    for (const store of this.folders) {
      const relative = toRelativePath(store.rootUri, target);
      if (relative === undefined) {
        continue;
      }
      found.push(...store.forFile(relative));
    }
    return found;
  }

  async add(annotation: Annotation): Promise<boolean> {
    const store = this.storeOf(annotation);
    return store ? store.add(annotation) : false;
  }

  async update(id: string, mutate: (annotation: Annotation) => Annotation): Promise<boolean> {
    const holders = this.holdersOf(id);
    let saved = holders.length > 0;
    for (const store of holders) {
      if (!(await store.update(id, mutate))) {
        saved = false;
      }
    }
    return saved;
  }

  async remove(id: string): Promise<boolean> {
    const holders = this.holdersOf(id);
    let saved = holders.length > 0;
    for (const store of holders) {
      if (!(await store.remove(id))) {
        saved = false;
      }
    }
    return saved;
  }

  async transaction(
    scope: vscode.Uri | string | undefined,
    apply: (annotations: Map<string, Annotation>) => boolean
  ): Promise<boolean> {
    const store = this.storeAt(scope);
    return store ? store.transaction(apply) : false;
  }

  storeAt(scope: vscode.Uri | string | undefined): FolderStore | undefined {
    if (scope === undefined) {
      const folders = this.folders;
      return folders.length === 1 ? folders[0] : undefined;
    }
    if (typeof scope === "string") {
      return this.stores.get(scope);
    }
    return this.stores.get(scope.toString()) ?? this.folderFor(scope);
  }

  async resolveConflict(): Promise<boolean> {
    const stuck = this.folders.filter((store) => store.conflicted);
    const asked = stuck.length > 0 ? stuck : this.folders;
    const outcomes = [];
    for (const store of asked) {
      outcomes.push(await store.resolveConflict());
    }
    this.tellAboutConflicts();
    if (!outcomes.includes("merged") && !outcomes.includes("stuck")) {
      void vscode.window.showInformationMessage(
        "CodeLight found no merge conflict to put back together."
      );
    }
    return outcomes.includes("merged");
  }

  tellAboutConflicts(): void {
    void vscode.commands.executeCommand(
      "setContext",
      "codelight.conflicted",
      this.folders.some((store) => store.conflicted)
    );
  }

  async refresh(): Promise<void> {
    await Promise.all(this.folders.map((store) => store.refresh()));
  }

  async convertStorage(): Promise<boolean> {
    const store = await this.chooseFolder("Pick the folder to convert");
    return store ? store.convertStorage() : false;
  }

  dispose(): void {
    for (const link of this.links.values()) {
      link.dispose();
    }
    for (const store of this.stores.values()) {
      store.dispose();
    }
    this.links.clear();
    this.stores.clear();
    this.emitter.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private storeOf(annotation: Annotation): FolderStore | undefined {
    if (annotation.root) {
      return this.stores.get(annotation.root);
    }
    const folders = this.folders;
    return folders.length === 1 ? folders[0] : undefined;
  }

  async pickFolder(what: string): Promise<vscode.Uri | undefined> {
    return (await this.chooseFolder(what))?.rootUri;
  }

  private async chooseFolder(what: string): Promise<FolderStore | undefined> {
    const folders = this.folders;
    if (folders.length <= 1) {
      return folders[0];
    }
    const active = vscode.window.activeTextEditor;
    const current = active ? this.folderFor(active.document.uri) : undefined;
    const picked = await vscode.window.showQuickPick(
      folders.map((store) => ({
        label: vscode.workspace.getWorkspaceFolder(store.rootUri)?.name ?? pathLabel(store.rootUri),
        description: pathLabel(store.rootUri),
        picked: store === current,
        store
      })),
      { title: "CodeLight", placeHolder: what }
    );
    return picked?.store;
  }

  private async sync(): Promise<void> {
    const wanted = new Map<string, vscode.Uri>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      wanted.set(folder.uri.toString(), folder.uri);
    }
    let changed = false;
    for (const [key, store] of [...this.stores]) {
      if (wanted.has(key)) {
        continue;
      }
      this.links.get(key)?.dispose();
      this.links.delete(key);
      store.dispose();
      this.stores.delete(key);
      changed = true;
    }
    const opening: Promise<void>[] = [];
    for (const [key, uri] of wanted) {
      if (this.stores.has(key)) {
        continue;
      }
      const store = new FolderStore(uri);
      this.stores.set(key, store);
      this.links.set(
        key,
        store.onDidChange(() => {
          this.tellAboutConflicts();
          this.emitter.fire();
        })
      );
      opening.push(store.initialize());
      changed = true;
    }
    await Promise.all(opening);
    this.tellAboutConflicts();
    if (changed) {
      this.emitter.fire();
    }
  }
}

import * as vscode from "vscode";
import { LiveRanges } from "./live";
import { Annotation, Comment } from "./model";
import { DEFAULT_PALETTE, PaletteColor, readPalette } from "./palette";
import { AnnotationStore } from "./store";
import { snippet } from "./thread";

export interface FileNode {
  kind: "file";
  file: string;
  root: string | undefined;
  annotations: Annotation[];
}

export interface AnnotationNode {
  kind: "annotation";
  annotation: Annotation;
}

export interface CommentNode {
  kind: "comment";
  annotation: Annotation;
  comment: Comment;
}

export type Node = FileNode | AnnotationNode | CommentNode;

export function basename(file: string): string {
  const parts = file.split("/");
  return parts[parts.length - 1] ?? file;
}

function directory(file: string): string {
  const parts = file.split("/");
  parts.pop();
  return parts.join("/");
}

function colorIcon(color: string, palette: readonly PaletteColor[]): vscode.ThemeIcon {
  const configured = palette.find((entry) => entry.id === color);
  const known = DEFAULT_PALETTE.some(
    (entry) =>
      entry.id === color &&
      (configured === undefined || entry.hex.toLowerCase() === configured.hex.toLowerCase())
  );
  return known
    ? new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor(`codelight.${color}`))
    : new vscode.ThemeIcon("circle-filled");
}

function trim(value: string, limit: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text === "") {
    return "empty comment";
  }
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export class AnnotationTree implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private filter: string | undefined;

  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly store: AnnotationStore) {
    this.disposables.push(store.onDidChange(() => this.emitter.fire(undefined)));
  }

  get activeFilter(): string | undefined {
    return this.filter;
  }

  setFilter(color: string | undefined): void {
    this.filter = color;
    void vscode.commands.executeCommand("setContext", "codelight.filtered", color !== undefined);
    this.emitter.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return this.files();
    }
    if (node.kind === "file") {
      return node.annotations.map((annotation) => ({ kind: "annotation", annotation }));
    }
    if (node.kind === "annotation") {
      return node.annotation.comments.map((comment) => ({
        kind: "comment",
        annotation: node.annotation,
        comment
      }));
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "file") {
      const item = new vscode.TreeItem(
        basename(node.file),
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.resourceUri = this.store.uriFor(node.annotations[0]);
      item.description = this.store.label(node.root, directory(node.file));
      item.contextValue = "codelight.file";
      item.iconPath = vscode.ThemeIcon.File;
      item.id = `file:${node.root ?? ""}:${node.file}`;
      return item;
    }
    if (node.kind === "annotation") {
      const annotation = node.annotation;
      const item = new vscode.TreeItem(
        snippet(annotation),
        annotation.comments.length > 0
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None
      );
      const parts = [`@${annotation.author.login}`];
      if (annotation.comments.length > 0) {
        parts.push(countLabel(annotation.comments.length, "comment"));
      }
      if (annotation.orphaned === true) {
        parts.push("text deleted");
      }
      item.description = parts.join(", ");
      item.contextValue = annotation.orphaned === true ? "codelight.orphan" : "codelight.annotation";
      item.iconPath =
        annotation.orphaned === true
          ? new vscode.ThemeIcon("circle-slash")
          : colorIcon(annotation.color, readPalette(this.store.uriFor(annotation)));
      item.id = `annotation:${annotation.id}`;
      item.tooltip = annotation.anchor.text;
      item.command = {
        command: "codelight.revealAnnotation",
        title: "Reveal",
        arguments: [annotation.id]
      };
      return item;
    }
    const item = new vscode.TreeItem(trim(node.comment.body, 80), vscode.TreeItemCollapsibleState.None);
    item.description = `@${node.comment.author.login}`;
    item.iconPath = new vscode.ThemeIcon("comment");
    item.contextValue = "codelight.comment";
    item.id = `comment:${node.annotation.id}:${node.comment.id}`;
    item.command = {
      command: "codelight.revealAnnotation",
      title: "Reveal",
      arguments: [node.annotation.id]
    };
    return item;
  }

  private files(): FileNode[] {
    const grouped = new Map<string, FileNode>();
    for (const annotation of this.store.all) {
      if (this.filter !== undefined && annotation.color !== this.filter) {
        continue;
      }
      const key = `${annotation.root ?? ""}\u0000${annotation.file}`;
      const node = grouped.get(key) ?? {
        kind: "file" as const,
        file: annotation.file,
        root: annotation.root,
        annotations: []
      };
      node.annotations.push(annotation);
      grouped.set(key, node);
    }
    return [...grouped.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([, node]) => ({
        ...node,
        annotations: node.annotations.sort((a, b) => a.range.startLine - b.range.startLine)
      }));
  }

  dispose(): void {
    this.emitter.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

export function nodeId(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return undefined;
  }
  const node = value as Node;
  if (node.kind === "annotation") {
    return node.annotation.id;
  }
  if (node.kind === "comment") {
    return node.annotation.id;
  }
  return undefined;
}

export class PanelCommands {
  constructor(
    private readonly store: AnnotationStore,
    private readonly live: LiveRanges,
    private readonly tree: AnnotationTree
  ) {}

  async reveal(annotationId: string): Promise<void> {
    const annotation = this.store.byId(annotationId);
    const uri = annotation ? this.store.uriFor(annotation) : undefined;
    if (!annotation || !uri) {
      void vscode.window.showWarningMessage("That highlight is no longer in the annotation file.");
      return;
    }
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch {
      void vscode.window.showWarningMessage(`CodeLight could not open ${annotation.file}.`);
      return;
    }
    try {
      const editor = await vscode.window.showTextDocument(document, { preserveFocus: false });
      const range = this.live.rangeFor(document, annotation);
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch {
      void vscode.window.showWarningMessage(`CodeLight could not open ${annotation.file}.`);
    }
  }

  async deleteAnnotation(node?: Node | string): Promise<void> {
    const id = nodeId(node);
    if (id === undefined) {
      return;
    }
    const annotation = this.store.byId(id);
    if (!annotation) {
      return;
    }
    const count = annotation.comments.length;
    if (count > 0) {
      const confirmed = await vscode.window.showWarningMessage(
        `Remove this highlight and its ${countLabel(count, "comment")}?`,
        { modal: true },
        "Remove"
      );
      if (confirmed !== "Remove") {
        return;
      }
    }
    await this.commitRemoval(new Map([[id, count]]), "Remove Highlight");
  }

  private async commitRemoval(expected: Map<string, number>, retry: string): Promise<void> {
    let drifted = false;
    let missing = false;
    let removed = false;
    const grouped = new Map<string, Map<string, number>>();
    for (const [id, count] of expected) {
      const holders = this.store.holdersOf(id);
      if (holders.length === 0) {
        missing = true;
        continue;
      }
      for (const holder of holders) {
        if (holder.byId(id)?.comments.length !== count) {
          drifted = true;
          break;
        }
        const bucket = grouped.get(holder.key) ?? new Map<string, number>();
        bucket.set(id, count);
        grouped.set(holder.key, bucket);
      }
      if (drifted) {
        break;
      }
    }
    if (drifted) {
      await this.store.refresh();
      void vscode.window.showWarningMessage(
        `Those comments just changed. Run ${retry} again to confirm.`
      );
      return;
    }
    let saved = grouped.size > 0;
    for (const [root, bucket] of grouped) {
      const done = await this.store.transaction(root, (annotations) => {
        let changed = false;
        for (const [id, count] of bucket) {
          const current = annotations.get(id);
          if (!current) {
            missing = true;
            continue;
          }
          if (current.comments.length !== count) {
            drifted = true;
            return false;
          }
          annotations.delete(id);
          changed = true;
          removed = true;
        }
        return changed;
      });
      if (!done) {
        saved = false;
      }
      if (drifted) {
        break;
      }
    }
    if (drifted) {
      await this.store.refresh();
      void vscode.window.showWarningMessage(
        `Those comments just changed. Run ${retry} again to confirm.`
      );
      return;
    }
    if (missing) {
      await this.store.refresh();
    }
    if (!saved && !removed && missing) {
      void vscode.window.showWarningMessage("That highlight is no longer in the annotation file.");
      return;
    }
    if (!saved) {
      void vscode.window.showWarningMessage("CodeLight could not update the annotation file.");
    }
  }

  async deleteFile(node?: Node): Promise<void> {
    if (!node || node.kind !== "file") {
      return;
    }
    const annotations = node.annotations.filter((entry) => this.store.byId(entry.id) !== undefined);
    if (annotations.length === 0) {
      return;
    }
    const comments = annotations.reduce((sum, entry) => sum + entry.comments.length, 0);
    const detail =
      comments === 0
        ? `Remove ${countLabel(annotations.length, "highlight")} from ${node.file}?`
        : `Remove ${countLabel(annotations.length, "highlight")} and ${countLabel(comments, "comment")} from ${node.file}?`;
    const confirmed = await vscode.window.showWarningMessage(detail, { modal: true }, "Remove");
    if (confirmed !== "Remove") {
      return;
    }
    await this.commitRemoval(
      new Map(annotations.map((entry) => [entry.id, entry.comments.length])),
      "Delete All Highlights in File"
    );
  }

  async deleteOrphansEverywhere(): Promise<void> {
    const orphans = this.store.all.filter((annotation) => annotation.orphaned === true);
    if (orphans.length === 0) {
      void vscode.window.showInformationMessage("No orphaned highlights in this project.");
      return;
    }
    const comments = orphans.reduce((sum, entry) => sum + entry.comments.length, 0);
    const detail =
      comments === 0
        ? `Delete ${countLabel(orphans.length, "orphaned highlight")}?`
        : `Delete ${countLabel(orphans.length, "orphaned highlight")} and ${countLabel(comments, "comment")}?`;
    const scope =
      this.tree.activeFilter === undefined
        ? "This covers every folder of the workspace."
        : "This covers every folder of the workspace. The colour filter does not narrow it.";
    const confirmed = await vscode.window.showWarningMessage(
      detail,
      { modal: true, detail: scope },
      "Delete"
    );
    if (confirmed !== "Delete") {
      return;
    }
    await this.commitRemoval(
      new Map(orphans.map((entry) => [entry.id, entry.comments.length])),
      "Delete All Orphaned Highlights"
    );
  }

  async filterByColor(): Promise<void> {
    const active = vscode.window.activeTextEditor;
    const palette = readPalette(active ? this.store.rootFor(active.document.uri) : undefined);
    const used = new Set(this.store.all.map((annotation) => annotation.color));
    const colors: PaletteColor[] = palette.filter((color) => used.has(color.id));
    for (const color of used) {
      if (!colors.some((entry) => entry.id === color)) {
        colors.push({ id: color, label: color, hex: "" });
      }
    }
    if (colors.length === 0) {
      void vscode.window.showInformationMessage("No highlights to filter.");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      [
        { label: "All colors", id: undefined as string | undefined },
        ...colors.map((color) => ({
          label: color.label,
          iconPath: colorIcon(color.id, palette),
          id: color.id as string | undefined
        }))
      ],
      { title: "Filter highlights" }
    );
    if (!picked) {
      return;
    }
    this.tree.setFilter(picked.id);
  }

  clearFilter(): void {
    this.tree.setFilter(undefined);
  }
}

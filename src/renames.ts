import * as vscode from "vscode";
import { Annotation } from "./model";
import { toRelativePath } from "./paths";
import { AnnotationStore } from "./store";

interface Move {
  readonly oldUri: vscode.Uri;
  readonly newUri: vscode.Uri;
}

interface Entry {
  from: string;
  to: string;
  target: string | undefined;
}

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

function comparable(value: string): string {
  return CASE_INSENSITIVE ? value.toLowerCase() : value;
}

function within(file: string, from: string): boolean {
  const one = comparable(file);
  const other = comparable(from);
  return one === other || one.startsWith(`${other}/`);
}

function rename(file: string, from: string, to: string): string {
  return within(file, from) && comparable(file) === comparable(from)
    ? to
    : `${to}${file.slice(from.length)}`;
}

function resolve(
  file: string,
  sorted: Entry[],
  key: string
): { file: string; out: string | undefined } {
  let landed = file;
  for (const entry of sorted) {
    if (!within(landed, entry.from)) {
      continue;
    }
    if (entry.target === undefined) {
      return { file: landed, out: "" };
    }
    if (entry.target !== key) {
      return { file: rename(landed, entry.from, entry.to), out: entry.target };
    }
    landed = rename(landed, entry.from, entry.to);
  }
  return { file: landed, out: undefined };
}

export class RenameWatcher implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private queue: Promise<number> = Promise.resolve(0);

  constructor(
    private readonly store: AnnotationStore,
    private readonly ready: Promise<unknown> = Promise.resolve()
  ) {
    this.disposables.push(
      vscode.workspace.onDidRenameFiles((event) => void this.follow([...event.files]))
    );
  }

  follow(moves: readonly Move[]): Promise<number> {
    const next = this.queue.then(
      () => this.apply(moves),
      () => this.apply(moves)
    );
    this.queue = next;
    return next;
  }

  private async apply(moves: readonly Move[]): Promise<number> {
    await this.ready.then(undefined, () => undefined);
    const byFolder = new Map<string, Entry[]>();
    for (const move of moves) {
      const landing = this.store.folderFor(move.newUri);
      for (const folder of this.store.foldersHolding(move.oldUri)) {
        const from = toRelativePath(folder.rootUri, move.oldUri);
        if (from === undefined) {
          continue;
        }
        const here = toRelativePath(folder.rootUri, move.newUri);
        const to = here ?? (landing ? toRelativePath(landing.rootUri, move.newUri) : undefined);
        if (to === undefined) {
          byFolder.set(folder.key, [
            ...(byFolder.get(folder.key) ?? []),
            { from, to: from, target: undefined }
          ]);
          continue;
        }
        byFolder.set(folder.key, [
          ...(byFolder.get(folder.key) ?? []),
          { from, to, target: here !== undefined ? folder.key : landing?.key }
        ]);
      }
    }
    let moved = 0;
    let stranded = 0;
    let stuck = 0;
    let doubled = 0;
    for (const [key, list] of byFolder) {
      const sorted = [...list].sort((a, b) => b.from.length - a.from.length);
      const result = await this.applyTo(key, sorted);
      moved += result.moved;
      stranded += result.stranded;
      stuck += result.stuck;
      doubled += result.doubled;
    }
    if (stranded > 0) {
      void vscode.window.showWarningMessage(
        stranded === 1
          ? "One note stayed on the path it had, because the file it marks moved out of this workspace."
          : `${stranded} notes stayed on the paths they had, because the files they mark moved out of this workspace.`
      );
    }
    if (doubled > 0) {
      void vscode.window.showWarningMessage(
        "A note followed its file into another folder of this workspace, and is listed in both folders now, because CodeLight could not write the annotation file it came from."
      );
    }
    if (stuck > 0) {
      void vscode.window.showWarningMessage(
        "CodeLight could not write the annotation file, so notes on a renamed file still point at the old path. Rename it back, or fix the annotation file and move it again."
      );
    }
    return moved;
  }

  private async applyTo(
    key: string,
    sorted: Entry[]
  ): Promise<{ moved: number; stranded: number; stuck: number; doubled: number }> {
    const folder = this.store.storeAt(key);
    if (!folder) {
      return { moved: 0, stranded: 0, stuck: 0, doubled: 0 };
    }
    const plan = folder.all.map((annotation) => ({
      annotation,
      ...resolve(annotation.file, sorted, key)
    }));
    const stranded = plan.filter((entry) => entry.out === "").length;
    const leaving = plan.filter((entry) => entry.out !== undefined && entry.out !== "");
    const staying = plan.filter((entry) => entry.out === undefined && entry.file !== entry.annotation.file);
    let moved = 0;
    let stuck = 0;
    if (staying.length > 0) {
      const landing = new Set(staying.map((entry) => entry.file));
      const going = new Set(staying.map((entry) => entry.annotation.id));
      let count = 0;
      const done = await this.store.transaction(key, (annotations) => {
        count = 0;
        for (const entry of staying) {
          const current = annotations.get(entry.annotation.id);
          if (!current) {
            continue;
          }
          annotations.set(entry.annotation.id, { ...current, file: entry.file });
          count += 1;
        }
        let orphaned = false;
        for (const [id, annotation] of annotations) {
          if (going.has(id) || annotation.orphaned === true || !landing.has(annotation.file)) {
            continue;
          }
          annotations.set(id, { ...annotation, orphaned: true });
          orphaned = true;
        }
        return count > 0 || orphaned;
      });
      if (done) {
        moved += count;
      } else {
        stuck = 1;
      }
    }
    let doubled = 0;
    if (leaving.length > 0) {
      const landed = await this.land(leaving);
      if (landed.size > 0) {
        const cleared = await this.store.transaction(key, (annotations) => {
          let removed = false;
          for (const id of landed) {
            removed = annotations.delete(id) || removed;
          }
          return removed;
        });
        if (cleared) {
          moved += landed.size;
        } else {
          doubled = landed.size;
        }
      }
      if (landed.size < leaving.length) {
        stuck = 1;
      }
    }
    return { moved, stranded, stuck, doubled };
  }

  private async land(
    leaving: Array<{ annotation: Annotation; file: string; out: string | undefined }>
  ): Promise<Set<string>> {
    const landed = new Set<string>();
    const byTarget = new Map<string, Array<{ annotation: Annotation; file: string }>>();
    for (const entry of leaving) {
      const target = entry.out as string;
      byTarget.set(target, [
        ...(byTarget.get(target) ?? []),
        { annotation: entry.annotation, file: entry.file }
      ]);
    }
    for (const [target, list] of byTarget) {
      const done = await this.store.transaction(target, (annotations) => {
        for (const entry of list) {
          annotations.set(entry.annotation.id, {
            ...entry.annotation,
            file: entry.file,
            root: target
          });
        }
        return true;
      });
      if (done) {
        for (const entry of list) {
          landed.add(entry.annotation.id);
        }
      }
    }
    return landed;
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

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
    if (!within(file, entry.from) || !within(landed, entry.from)) {
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
    this.queue = next.then(
      () => 0,
      () => 0
    );
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
    let conflicted = 0;
    let doubled = 0;
    const plans = new Map<string, Entry[]>();
    const going = new Set<string>();
    for (const [key, list] of byFolder) {
      const sorted = [...list].sort((a, b) => b.from.length - a.from.length);
      plans.set(key, sorted);
      for (const annotation of this.store.storeAt(key)?.all ?? []) {
        const { file, out } = resolve(annotation.file, sorted, key);
        if (out === "" || (out === undefined && file === annotation.file)) {
          continue;
        }
        going.add(annotation.id);
      }
    }
    for (const [key, sorted] of plans) {
      const result = await this.applyTo(key, sorted, going);
      moved += result.moved;
      stranded += result.stranded;
      stuck += result.stuck;
      conflicted += result.conflicted;
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
    if (conflicted > 0) {
      void vscode.window.showWarningMessage(
        "Notes on a renamed file still point at the old path, because the annotation file has a merge conflict in it. Merge the notes, then move the file again to bring them along."
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
    sorted: Entry[],
    going: ReadonlySet<string>
  ): Promise<{ moved: number; stranded: number; stuck: number; conflicted: number; doubled: number }> {
    const folder = this.store.storeAt(key);
    if (!folder) {
      return { moved: 0, stranded: 0, stuck: 0, conflicted: 0, doubled: 0 };
    }
    const plan = folder.all.map((annotation) => ({
      annotation,
      ...resolve(annotation.file, sorted, key)
    }));
    const stranded = plan.filter(
      (entry) => entry.out === "" && entry.annotation.orphaned !== true
    ).length;
    const leaving = new Map<string, { file: string; target: string }>();
    for (const entry of plan) {
      if (entry.out !== undefined && entry.out !== "") {
        leaving.set(entry.annotation.id, { file: entry.file, target: entry.out });
      }
    }
    const wanted = new Map<string, string>();
    for (const entry of plan) {
      if (entry.out === undefined && entry.file !== entry.annotation.file) {
        wanted.set(entry.annotation.id, entry.file);
      }
    }
    let moved = 0;
    let stuck = 0;
    let doubled = 0;
    if (wanted.size > 0) {
      let count = 0;
      let ran = false;
      let applied = false;
      const done = await this.store.transaction(key, (annotations) => {
        ran = true;
        count = 0;
        const landing = new Set<string>();
        for (const [id, file] of wanted) {
          const current = annotations.get(id);
          if (!current) {
            continue;
          }
          landing.add(comparable(file));
          if (current.file === file) {
            continue;
          }
          annotations.set(id, { ...current, file });
          count += 1;
        }
        let orphaned = false;
        for (const [id, annotation] of annotations) {
          if (
            going.has(id) ||
            annotation.orphaned === true ||
            !landing.has(comparable(annotation.file))
          ) {
            continue;
          }
          annotations.set(id, { ...annotation, orphaned: true });
          orphaned = true;
        }
        applied = count > 0 || orphaned;
        return applied;
      });
      if (done) {
        moved += count;
      } else if (!ran || applied) {
        stuck = 1;
      }
    }
    if (leaving.size > 0 && !folder.conflicted) {
      const carry = new Map<string, Annotation>();
      await this.store.transaction(key, (annotations) => {
        carry.clear();
        for (const [id, where] of leaving) {
          const current = annotations.get(id);
          if (current) {
            carry.set(id, { ...current, file: where.file });
          }
        }
        return false;
      });
      const byTarget = new Map<string, Annotation[]>();
      for (const [id, annotation] of carry) {
        const target = leaving.get(id)?.target;
        if (target !== undefined) {
          byTarget.set(target, [...(byTarget.get(target) ?? []), annotation]);
        }
      }
      const { landed, stuckOn } = await this.land(byTarget, going);
      if (landed.size > 0) {
        let held = 0;
        const cleared = await this.store.transaction(key, (annotations) => {
          held = 0;
          for (const id of landed) {
            held += annotations.delete(id) ? 1 : 0;
          }
          return held > 0;
        });
        if (cleared || held === 0) {
          moved += landed.size;
        } else {
          doubled = landed.size;
        }
      }
      if (landed.size < carry.size) {
        if (stuckOn) {
          return { moved, stranded, stuck: 0, conflicted: 1, doubled };
        }
        stuck = 1;
      }
    }
    const conflicted = folder.conflicted && (wanted.size > 0 || leaving.size > 0) ? 1 : 0;
    return { moved, stranded, stuck: conflicted === 1 ? 0 : stuck, conflicted, doubled };
  }

  private async land(
    byTarget: Map<string, Annotation[]>,
    going: ReadonlySet<string>
  ): Promise<{ landed: Set<string>; stuckOn: boolean }> {
    const landed = new Set<string>();
    let stuckOn = false;
    for (const [target, list] of byTarget) {
      const arriving = new Set(list.map((entry) => comparable(entry.file)));
      const done = await this.store.transaction(target, (annotations) => {
        for (const [id, annotation] of annotations) {
          if (
            going.has(id) ||
            annotation.orphaned === true ||
            !arriving.has(comparable(annotation.file))
          ) {
            continue;
          }
          annotations.set(id, { ...annotation, orphaned: true });
        }
        for (const entry of list) {
          annotations.set(entry.id, { ...entry, root: target });
        }
        return true;
      });
      if (done) {
        for (const entry of list) {
          landed.add(entry.id);
        }
      } else if (this.store.storeAt(target)?.conflicted === true) {
        stuckOn = true;
      }
    }
    return { landed, stuckOn };
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

import * as vscode from "vscode";
import { Annotation } from "./model";
import { AnnotationStore } from "./store";

interface Move {
  readonly oldUri: vscode.Uri;
  readonly newUri: vscode.Uri;
}

function within(file: string, from: string): boolean {
  return file === from || file.startsWith(`${from}/`);
}

export class RenameWatcher implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly store: AnnotationStore) {
    this.disposables.push(
      vscode.workspace.onDidRenameFiles((event) => void this.follow([...event.files]))
    );
  }

  async follow(moves: readonly Move[]): Promise<number> {
    const byFolder = new Map<string, Array<{ from: string; to: string; root: string }>>();
    for (const move of moves) {
      const holder = this.store.folderFor(move.oldUri);
      const landing = this.store.folderFor(move.newUri);
      if (!holder) {
        continue;
      }
      const from = this.store.relative(move.oldUri);
      const to = landing ? this.store.relative(move.newUri) : undefined;
      if (from === undefined) {
        continue;
      }
      const key = holder.key;
      byFolder.set(key, [
        ...(byFolder.get(key) ?? []),
        { from, to: to ?? "", root: landing?.key ?? "" }
      ]);
    }
    let moved = 0;
    for (const [key, list] of byFolder) {
      const staying = list.filter((entry) => entry.root === key && entry.to !== "");
      if (staying.length === 0) {
        continue;
      }
      const done = await this.store.transaction(key, (annotations) => {
        let changed = false;
        for (const [id, annotation] of annotations) {
          const hit = staying.find((entry) => within(annotation.file, entry.from));
          if (!hit) {
            continue;
          }
          annotations.set(id, { ...annotation, file: rename(annotation.file, hit.from, hit.to) });
          changed = true;
          moved += 1;
        }
        return changed;
      });
      if (!done) {
        moved = 0;
      }
    }
    return moved;
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

function rename(file: string, from: string, to: string): Annotation["file"] {
  return file === from ? to : `${to}${file.slice(from.length)}`;
}

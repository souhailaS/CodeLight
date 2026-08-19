import * as vscode from "vscode";
import { Annotation } from "./model";
import { toRelativePath } from "./paths";
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
    const byFolder = new Map<string, Array<{ from: string; to: string }>>();
    for (const move of moves) {
      for (const folder of this.store.foldersHolding(move.oldUri)) {
        const from = toRelativePath(folder.rootUri, move.oldUri);
        const to = toRelativePath(folder.rootUri, move.newUri);
        if (from === undefined || to === undefined) {
          continue;
        }
        byFolder.set(folder.key, [...(byFolder.get(folder.key) ?? []), { from, to }]);
      }
    }
    let moved = 0;
    for (const [key, list] of byFolder) {
      let here = 0;
      const done = await this.store.transaction(key, (annotations) => {
        here = 0;
        for (const [id, annotation] of annotations) {
          const hit = list.find((entry) => within(annotation.file, entry.from));
          if (!hit) {
            continue;
          }
          annotations.set(id, { ...annotation, file: rename(annotation.file, hit.from, hit.to) });
          here += 1;
        }
        return here > 0;
      });
      if (done) {
        moved += here;
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

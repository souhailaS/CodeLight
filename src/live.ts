import * as vscode from "vscode";
import { Annotation } from "./model";
import { toRelativePath } from "./paths";
import { AnnotationStore } from "./store";

interface Span {
  start: number;
  end: number;
}

function shiftPoint(point: number, start: number, end: number, delta: number): number {
  if (point <= start) {
    return point;
  }
  if (point >= end) {
    return point + delta;
  }
  return start;
}

function shiftSpan(span: Span, start: number, end: number, delta: number): Span {
  const nextStart = shiftPoint(span.start, start, end, delta);
  const nextEnd = shiftPoint(span.end, start, end, delta);
  return { start: nextStart, end: Math.max(nextStart, nextEnd) };
}

export class LiveRanges implements vscode.Disposable {
  private readonly documents = new Map<string, Map<string, Span>>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<vscode.TextDocument>();

  readonly onDidShift = this.changeEmitter.event;

  constructor(private readonly store: AnnotationStore) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => this.applyChanges(event)),
      vscode.workspace.onDidSaveTextDocument((document) => void this.flush(document)),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.documents.delete(document.uri.toString());
      })
    );
  }

  rangeFor(document: vscode.TextDocument, annotation: Annotation): vscode.Range {
    const spans = this.sync(document);
    const span = spans?.get(annotation.id);
    if (!span) {
      return document.validateRange(
        new vscode.Range(
          annotation.range.startLine,
          annotation.range.startCharacter,
          annotation.range.endLine,
          annotation.range.endCharacter
        )
      );
    }
    return new vscode.Range(document.positionAt(span.start), document.positionAt(span.end));
  }

  private relativePath(document: vscode.TextDocument): string | undefined {
    const root = this.store.rootUri;
    return root ? toRelativePath(root, document.uri) : undefined;
  }

  private sync(document: vscode.TextDocument): Map<string, Span> | undefined {
    const relative = this.relativePath(document);
    if (!relative) {
      return undefined;
    }
    const stored = this.store.forFile(relative);
    const key = document.uri.toString();
    const existing = this.documents.get(key);
    if (!existing || !document.isDirty) {
      const fresh = new Map<string, Span>();
      for (const annotation of stored) {
        fresh.set(annotation.id, this.spanOf(document, annotation));
      }
      this.documents.set(key, fresh);
      return fresh;
    }
    const ids = new Set(stored.map((annotation) => annotation.id));
    for (const id of [...existing.keys()]) {
      if (!ids.has(id)) {
        existing.delete(id);
      }
    }
    for (const annotation of stored) {
      if (!existing.has(annotation.id)) {
        existing.set(annotation.id, this.spanOf(document, annotation));
      }
    }
    return existing;
  }

  private spanOf(document: vscode.TextDocument, annotation: Annotation): Span {
    const start = document.offsetAt(
      new vscode.Position(annotation.range.startLine, annotation.range.startCharacter)
    );
    const end = document.offsetAt(
      new vscode.Position(annotation.range.endLine, annotation.range.endCharacter)
    );
    return { start, end: Math.max(start, end) };
  }

  private applyChanges(event: vscode.TextDocumentChangeEvent): void {
    if (event.contentChanges.length === 0) {
      return;
    }
    const spans = this.documents.get(event.document.uri.toString());
    if (!spans || spans.size === 0) {
      return;
    }
    for (const change of event.contentChanges) {
      const start = change.rangeOffset;
      const end = start + change.rangeLength;
      const delta = change.text.length - change.rangeLength;
      for (const [id, span] of spans) {
        spans.set(id, shiftSpan(span, start, end, delta));
      }
    }
    this.changeEmitter.fire(event.document);
  }

  private async flush(document: vscode.TextDocument): Promise<void> {
    const relative = this.relativePath(document);
    const spans = relative ? this.documents.get(document.uri.toString()) : undefined;
    if (!relative || !spans || spans.size === 0) {
      return;
    }
    const moved = new Map<string, Span>();
    for (const annotation of this.store.forFile(relative)) {
      const span = spans.get(annotation.id);
      if (!span) {
        continue;
      }
      const current = this.spanOf(document, annotation);
      if (current.start !== span.start || current.end !== span.end) {
        moved.set(annotation.id, span);
      }
    }
    if (moved.size === 0) {
      return;
    }
    this.documents.delete(document.uri.toString());
    await this.store.transaction((annotations) => {
      let changed = false;
      for (const [id, span] of moved) {
        const annotation = annotations.get(id);
        if (!annotation) {
          continue;
        }
        const start = document.positionAt(span.start);
        const end = document.positionAt(span.end);
        annotations.set(id, {
          ...annotation,
          range: {
            startLine: start.line,
            startCharacter: start.character,
            endLine: end.line,
            endCharacter: end.character
          }
        });
        changed = true;
      }
      return changed;
    });
  }

  dispose(): void {
    this.changeEmitter.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

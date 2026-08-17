import * as vscode from "vscode";
import { Annotation } from "./model";
import { toRelativePath } from "./paths";
import { shiftSpan, Span } from "./ranges";
import { AnnotationStore } from "./store";

export type SpanMap = Map<string, Span>;

export class LiveRanges implements vscode.Disposable {
  private readonly documents = new Map<string, SpanMap>();
  private readonly flushing = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<vscode.TextDocument>();

  readonly onDidShift = this.changeEmitter.event;

  constructor(private readonly store: AnnotationStore) {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((document) => {
        this.spansFor(document);
      }),
      vscode.workspace.onDidChangeTextDocument((event) => this.applyChanges(event)),
      vscode.workspace.onDidSaveTextDocument((document) => void this.flushDocument(document)),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.documents.delete(document.uri.toString());
      }),
      store.onDidChange(() => this.seedOpenDocuments())
    );
    this.seedOpenDocuments();
  }

  spansFor(document: vscode.TextDocument): SpanMap | undefined {
    const relative = this.relativePath(document);
    if (!relative) {
      return undefined;
    }
    return this.sync(document, this.store.forFile(relative));
  }

  rangeFor(document: vscode.TextDocument, annotation: Annotation, spans?: SpanMap): vscode.Range {
    const resolved = spans ?? this.spansFor(document);
    const span = resolved?.get(annotation.id);
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

  async flushDocument(document: vscode.TextDocument): Promise<void> {
    const relative = this.relativePath(document);
    const spans = relative ? this.documents.get(document.uri.toString()) : undefined;
    if (!relative || !spans || spans.size === 0) {
      return;
    }
    const moved = new Map<string, { start: vscode.Position; end: vscode.Position }>();
    for (const annotation of this.store.forFile(relative)) {
      const span = spans.get(annotation.id);
      if (!span) {
        continue;
      }
      if (span.start === span.end) {
        continue;
      }
      const current = this.spanOf(document, annotation);
      if (current.start === span.start && current.end === span.end) {
        continue;
      }
      moved.set(annotation.id, {
        start: document.positionAt(span.start),
        end: document.positionAt(span.end)
      });
    }
    if (moved.size === 0) {
      return;
    }
    const key = document.uri.toString();
    this.flushing.add(key);
    try {
      await this.persistMoved(moved);
    } finally {
      this.flushing.delete(key);
    }
  }

  private async persistMoved(
    moved: Map<string, { start: vscode.Position; end: vscode.Position }>
  ): Promise<void> {
    await this.store.transaction((annotations) => {
      let changed = false;
      for (const [id, position] of moved) {
        const annotation = annotations.get(id);
        if (!annotation) {
          continue;
        }
        annotations.set(id, {
          ...annotation,
          range: {
            startLine: position.start.line,
            startCharacter: position.start.character,
            endLine: position.end.line,
            endCharacter: position.end.character
          }
        });
        changed = true;
      }
      return changed;
    });
  }

  private seedOpenDocuments(): void {
    for (const document of vscode.workspace.textDocuments) {
      this.spansFor(document);
    }
  }

  private relativePath(document: vscode.TextDocument): string | undefined {
    const root = this.store.rootUri;
    return root ? toRelativePath(root, document.uri) : undefined;
  }

  private sync(document: vscode.TextDocument, stored: readonly Annotation[]): SpanMap {
    const key = document.uri.toString();
    const existing = this.documents.get(key);
    if (!existing || (!document.isDirty && !this.flushing.has(key))) {
      const fresh: SpanMap = new Map();
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

  dispose(): void {
    this.changeEmitter.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

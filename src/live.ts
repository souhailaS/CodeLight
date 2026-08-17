import * as vscode from "vscode";
import { buildAnchor } from "./anchors";
import { Annotation, AnnotationRange } from "./model";
import { toRelativePath } from "./paths";
import { shiftSpan, Span } from "./ranges";
import { AnnotationStore } from "./store";

export type SpanMap = Map<string, Span>;

interface Placement {
  start: vscode.Position;
  end: vscode.Position;
}

interface DocumentState {
  spans: SpanMap;
  placements: Map<string, Placement>;
  seeded: Map<string, AnnotationRange>;
  eol: vscode.EndOfLine;
}

function sameRange(a: AnnotationRange, b: AnnotationRange): boolean {
  return (
    a.startLine === b.startLine &&
    a.startCharacter === b.startCharacter &&
    a.endLine === b.endLine &&
    a.endCharacter === b.endCharacter
  );
}

export class LiveRanges implements vscode.Disposable {
  private readonly documents = new Map<string, DocumentState>();
  private readonly holding = new Set<string>();
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
      vscode.workspace.onDidCloseTextDocument((document) => this.forget(document)),
      store.onDidChange(() => this.seedOpenDocuments())
    );
    this.seedOpenDocuments();
  }

  spansFor(document: vscode.TextDocument): SpanMap | undefined {
    const relative = this.relativePath(document);
    if (!relative) {
      return undefined;
    }
    return this.sync(document, this.store.forFile(relative)).spans;
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
    const key = document.uri.toString();
    const relative = this.relativePath(document);
    const state = relative ? this.documents.get(key) : undefined;
    if (!relative || !state || state.spans.size === 0) {
      this.holding.delete(key);
      return;
    }
    const text = document.getText();
    const moved = new Map<string, { placement: Placement; anchorText: string }>();
    const orphaned = new Map<string, Placement>();
    for (const annotation of this.store.forFile(relative)) {
      if (annotation.orphaned === true) {
        continue;
      }
      const span = state.spans.get(annotation.id);
      const placement = state.placements.get(annotation.id);
      const seeded = state.seeded.get(annotation.id);
      if (!span || !placement || !seeded || !sameRange(seeded, annotation.range)) {
        continue;
      }
      if (span.start === span.end) {
        if (annotation.anchor.text !== "" && text.includes(annotation.anchor.text)) {
          continue;
        }
        orphaned.set(annotation.id, placement);
        continue;
      }
      const current = this.spanOf(document, annotation);
      if (current.start === span.start && current.end === span.end) {
        continue;
      }
      moved.set(annotation.id, { placement, anchorText: text.slice(span.start, span.end) });
    }
    if (moved.size === 0 && orphaned.size === 0) {
      this.holding.delete(key);
      return;
    }
    const saved = await this.store.transaction((annotations) => {
      let changed = false;
      for (const [id, entry] of moved) {
        const annotation = annotations.get(id);
        if (!annotation) {
          continue;
        }
        const start = document.offsetAt(entry.placement.start);
        annotations.set(id, {
          ...annotation,
          anchor: buildAnchor(text, start, start + entry.anchorText.length),
          range: {
            startLine: entry.placement.start.line,
            startCharacter: entry.placement.start.character,
            endLine: entry.placement.end.line,
            endCharacter: entry.placement.end.character
          }
        });
        changed = true;
      }
      for (const [id, placement] of orphaned) {
        const annotation = annotations.get(id);
        if (!annotation) {
          continue;
        }
        annotations.set(id, {
          ...annotation,
          orphaned: true,
          range: {
            startLine: placement.start.line,
            startCharacter: placement.start.character,
            endLine: placement.end.line,
            endCharacter: placement.end.character
          }
        });
        changed = true;
      }
      return changed;
    });
    const stillPresent = [...moved.keys(), ...orphaned.keys()].some(
      (id) => this.store.byId(id) !== undefined
    );
    if (saved || !stillPresent) {
      this.holding.delete(key);
    }
  }

  private forget(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    this.documents.delete(key);
    this.holding.delete(key);
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

  private sync(document: vscode.TextDocument, stored: readonly Annotation[]): DocumentState {
    const key = document.uri.toString();
    const existing = this.documents.get(key);
    if (!existing || (!document.isDirty && !this.holding.has(key))) {
      const state: DocumentState = {
        spans: new Map(),
        placements: new Map(),
        seeded: new Map(),
        eol: document.eol
      };
      for (const annotation of stored) {
        if (annotation.orphaned === true) {
          continue;
        }
        state.spans.set(annotation.id, this.spanOf(document, annotation));
        state.seeded.set(annotation.id, annotation.range);
      }
      this.refreshPlacements(document, state);
      this.documents.set(key, state);
      return state;
    }
    const ids = new Set(
      stored.filter((annotation) => annotation.orphaned !== true).map((annotation) => annotation.id)
    );
    for (const id of [...existing.spans.keys()]) {
      if (!ids.has(id)) {
        existing.spans.delete(id);
        existing.placements.delete(id);
        existing.seeded.delete(id);
      }
    }
    for (const annotation of stored) {
      if (annotation.orphaned !== true && !existing.spans.has(annotation.id)) {
        const span = this.spanOf(document, annotation);
        existing.spans.set(annotation.id, span);
        existing.seeded.set(annotation.id, annotation.range);
        existing.placements.set(annotation.id, {
          start: document.positionAt(span.start),
          end: document.positionAt(span.end)
        });
      }
    }
    return existing;
  }

  private refreshPlacements(document: vscode.TextDocument, state: DocumentState): void {
    state.placements = new Map();
    for (const [id, span] of state.spans) {
      state.placements.set(id, {
        start: document.positionAt(span.start),
        end: document.positionAt(span.end)
      });
    }
    state.eol = document.eol;
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
    const key = event.document.uri.toString();
    if (!this.documents.has(key)) {
      this.spansFor(event.document);
    }
    const state = this.documents.get(key);
    if (!state || state.spans.size === 0) {
      return;
    }
    if (event.contentChanges.length === 0) {
      if (event.document.eol === state.eol) {
        return;
      }
      for (const [id, placement] of state.placements) {
        const start = event.document.offsetAt(placement.start);
        const end = event.document.offsetAt(placement.end);
        state.spans.set(id, { start, end: Math.max(start, end) });
      }
      state.eol = event.document.eol;
      this.afterShift(event.document);
      return;
    }
    for (const change of event.contentChanges) {
      const start = change.rangeOffset;
      const end = start + change.rangeLength;
      const delta = change.text.length - change.rangeLength;
      for (const [id, span] of state.spans) {
        state.spans.set(id, shiftSpan(span, start, end, delta));
      }
    }
    this.refreshPlacements(event.document, state);
    this.afterShift(event.document);
  }

  private afterShift(document: vscode.TextDocument): void {
    if (!document.isDirty) {
      this.forget(document);
      this.changeEmitter.fire(document);
      return;
    }
    this.holding.add(document.uri.toString());
    this.changeEmitter.fire(document);
  }

  dispose(): void {
    this.changeEmitter.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

import * as vscode from "vscode";
import { buildAnchor, findAnchor, Located, MAX_ANCHOR_TEXT } from "./anchors";
import { Anchor, Annotation, AnnotationRange } from "./model";
import { shiftSpan, Span } from "./ranges";
import { AnnotationStore } from "./store";

export type SpanMap = Map<string, Span>;

interface Placement {
  start: vscode.Position;
  end: vscode.Position;
}

interface Move {
  placement: Placement;
  anchor: Anchor;
  span: Span;
}

interface DocumentState {
  spans: SpanMap;
  placements: Map<string, Placement>;
  seeded: Map<string, AnnotationRange>;
  detached: Set<string>;
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

function toRange(placement: Placement): AnnotationRange {
  return {
    startLine: placement.start.line,
    startCharacter: placement.start.character,
    endLine: placement.end.line,
    endCharacter: placement.end.character
  };
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

  detachedIn(document: vscode.TextDocument): ReadonlySet<string> {
    return this.placedIn(document).detached;
  }

  placedIn(document: vscode.TextDocument): { spans: SpanMap; detached: ReadonlySet<string> } {
    const relative = this.relativePath(document);
    if (!relative) {
      return { spans: new Map(), detached: new Set() };
    }
    const state = this.sync(document, this.store.forFile(document.uri));
    return { spans: state.spans, detached: new Set(state.detached) };
  }

  spansFor(document: vscode.TextDocument): SpanMap | undefined {
    const relative = this.relativePath(document);
    if (!relative) {
      return undefined;
    }
    return this.sync(document, this.store.forFile(document.uri)).spans;
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
    const stored = relative ? this.store.forFile(document.uri) : [];
    if (!state || stored.length === 0) {
      this.holding.delete(key);
      return;
    }
    const text = document.getText();
    const moved = new Map<string, Move>();
    const orphaned = new Map<string, Placement>();
    for (const annotation of stored) {
      if (annotation.orphaned === true) {
        const recovered = this.recover(document, text, annotation);
        if (recovered) {
          moved.set(annotation.id, this.toMove(document, text, recovered));
        }
        continue;
      }
      if (state.detached.has(annotation.id)) {
        continue;
      }
      const span = state.spans.get(annotation.id);
      const placement = state.placements.get(annotation.id);
      const seeded = state.seeded.get(annotation.id);
      if (!span || !placement || !seeded || !sameRange(seeded, annotation.range)) {
        continue;
      }
      let live = span;
      if (live.start === live.end) {
        const recovered = this.recover(document, text, annotation);
        if (!recovered) {
          orphaned.set(annotation.id, placement);
          continue;
        }
        live = recovered;
      }
      const current = this.spanOf(document, annotation);
      const currentText = text.slice(live.start, live.end).slice(0, MAX_ANCHOR_TEXT);
      if (
        current.start === live.start &&
        current.end === live.end &&
        currentText === annotation.anchor.text
      ) {
        continue;
      }
      moved.set(annotation.id, this.toMove(document, text, live));
    }
    if (moved.size === 0 && orphaned.size === 0) {
      this.holding.delete(key);
      return;
    }
    const version = document.version;
    const saved = await this.store.transaction(document.uri, (annotations) => {
      let changed = false;
      for (const [id, move] of moved) {
        const annotation = annotations.get(id);
        if (!annotation) {
          continue;
        }
        annotations.set(id, {
          ...annotation,
          orphaned: undefined,
          anchor: move.anchor,
          range: toRange(move.placement)
        });
        changed = true;
      }
      for (const [id, placement] of orphaned) {
        const annotation = annotations.get(id);
        if (!annotation) {
          continue;
        }
        annotations.set(id, { ...annotation, orphaned: true, range: toRange(placement) });
        changed = true;
      }
      return changed;
    });
    const stillPresent = [...moved.keys(), ...orphaned.keys()].some(
      (id) => this.store.byId(id) !== undefined
    );
    if (!saved && stillPresent) {
      return;
    }
    this.holding.delete(key);
    if (!document.isDirty) {
      this.documents.delete(key);
      this.spansFor(document);
      return;
    }
    const unchanged = document.version === version;
    for (const [id, move] of moved) {
      state.seeded.set(id, toRange(move.placement));
      if (unchanged) {
        state.spans.set(id, move.span);
        state.placements.set(id, move.placement);
      }
    }
    for (const id of orphaned.keys()) {
      state.spans.delete(id);
      state.placements.delete(id);
      state.seeded.delete(id);
    }
  }

  private toMove(document: vscode.TextDocument, text: string, span: Span): Move {
    return {
      span,
      placement: { start: document.positionAt(span.start), end: document.positionAt(span.end) },
      anchor: buildAnchor(text, span.start, span.end)
    };
  }

  private recover(
    document: vscode.TextDocument,
    text: string,
    annotation: Annotation
  ): Span | undefined {
    const found = findAnchor(text, annotation.anchor);
    if (!found) {
      return undefined;
    }
    return this.expand(text, annotation, found, this.spanOf(document, annotation));
  }

  private expand(text: string, annotation: Annotation, found: Located, stored: Span): Span {
    if (annotation.anchor.text.length < MAX_ANCHOR_TEXT) {
      return { start: found.start, end: found.end };
    }
    const length = Math.max(found.end - found.start, stored.end - stored.start);
    return { start: found.start, end: Math.min(text.length, found.start + length) };
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
    return this.store.relative(document.uri);
  }

  private sync(document: vscode.TextDocument, stored: readonly Annotation[]): DocumentState {
    const key = document.uri.toString();
    const existing = this.documents.get(key);
    if (!existing || (!document.isDirty && !this.holding.has(key))) {
      const state: DocumentState = {
        spans: new Map(),
        placements: new Map(),
        seeded: new Map(),
        detached: new Set(),
        eol: document.eol
      };
      const live = stored.filter((annotation) => annotation.orphaned !== true);
      const text = live.length > 0 ? document.getText() : "";
      for (const annotation of live) {
        const seeded = this.seedSpan(document, text, annotation);
        state.spans.set(annotation.id, seeded.span);
        state.seeded.set(annotation.id, annotation.range);
        if (seeded.detached) {
          state.detached.add(annotation.id);
        }
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
        existing.detached.delete(id);
      }
    }
    const arriving = stored.filter(
      (annotation) => annotation.orphaned !== true && !existing.spans.has(annotation.id)
    );
    const arrivingText = arriving.length > 0 ? document.getText() : "";
    for (const annotation of arriving) {
      const seeded = this.seedSpan(document, arrivingText, annotation);
      existing.spans.set(annotation.id, seeded.span);
      existing.seeded.set(annotation.id, annotation.range);
      if (seeded.detached) {
        existing.detached.add(annotation.id);
      } else {
        existing.detached.delete(annotation.id);
      }
      existing.placements.set(annotation.id, {
        start: document.positionAt(seeded.span.start),
        end: document.positionAt(seeded.span.end)
      });
    }
    return existing;
  }

  private seedSpan(
    document: vscode.TextDocument,
    text: string,
    annotation: Annotation
  ): { span: Span; detached: boolean } {
    const span = this.spanOf(document, annotation);
    if (
      annotation.anchor.text === "" ||
      text.slice(span.start, span.end) === annotation.anchor.text
    ) {
      return { span, detached: false };
    }
    const found = findAnchor(text, annotation.anchor);
    if (found) {
      return { span: this.expand(text, annotation, found, span), detached: false };
    }
    return { span, detached: true };
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
      this.changeEmitter.fire(event.document);
      return;
    }
    const state = this.documents.get(key);
    if (!state) {
      return;
    }
    if (state.spans.size === 0) {
      state.eol = event.document.eol;
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
      for (const [id, span] of state.spans) {
        state.spans.set(id, shiftSpan(span, start, end, change.text.length));
      }
    }
    this.refreshPlacements(event.document, state);
    this.afterShift(event.document);
  }

  private afterShift(document: vscode.TextDocument): void {
    if (!document.isDirty) {
      this.forget(document);
      this.spansFor(document);
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

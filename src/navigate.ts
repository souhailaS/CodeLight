import * as vscode from "vscode";
import { Annotation } from "./model";
import { LiveRanges } from "./live";
import { AnnotationStore } from "./store";
import { Visibility } from "./visibility";

interface Stop {
  annotation: Annotation;
  range: vscode.Range;
}

function order(a: Stop, b: Stop): number {
  const start = a.range.start.compareTo(b.range.start);
  return start !== 0 ? start : a.range.end.compareTo(b.range.end);
}

function sameRange(one: vscode.Range, other: vscode.Range): boolean {
  return one.start.isEqual(other.start) && one.end.isEqual(other.end);
}

function holds(range: vscode.Range, position: vscode.Position): boolean {
  return range.start.isBeforeOrEqual(position) && range.end.isAfterOrEqual(position);
}

export class Navigation implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private cached: Stop[] | undefined;
  private cacheKey = "";
  private tracked: vscode.TextEditor | undefined;
  private landedOn: { uri: string; position: vscode.Position; id: string } | undefined;

  constructor(
    private readonly store: AnnotationStore,
    private readonly live: LiveRanges,
    private readonly visibility: Visibility
  ) {
    this.disposables.push(
      store.onDidChange(() => this.forget()),
      live.onDidShift(() => this.forget())
    );
  }

  async step(forward: boolean): Promise<boolean> {
    const editor = this.editor();
    if (!editor) {
      void vscode.window.showInformationMessage(
        "Open a file to step through the highlights in it."
      );
      return false;
    }
    const all = this.store.forFile(editor.document.uri);
    if (all.length === 0) {
      void vscode.window.showInformationMessage("This file has no highlights.");
      return false;
    }
    const stops = this.stopsIn(editor.document, all);
    if (stops.length === 0) {
      void vscode.window.showWarningMessage(
        all.length === 1
          ? "The one highlight in this file marks text CodeLight cannot find here, so there is nothing to jump to."
          : `All ${all.length} highlights in this file mark text CodeLight cannot find here, so there is nothing to jump to.`
      );
      return false;
    }
    const { at, wrapped } = this.next(stops, editor, forward);
    const target = stops[at];
    const landed = await this.land(editor, target.range, target.annotation.id);
    if (!landed) {
      return false;
    }
    this.say(stops, all.length - stops.length, at, wrapped);
    return true;
  }

  private next(
    stops: Stop[],
    editor: vscode.TextEditor,
    forward: boolean
  ): { at: number; wrapped: boolean } {
    const selection = editor.selection;
    const left = this.left(stops, editor);
    const here = left !== -1 ? left : stops.findIndex((stop) => sameRange(stop.range, selection));
    const on = here !== -1 ? here : stops.findIndex((stop) => holds(stop.range, selection.start));
    if (on !== -1) {
      const step = on + (forward ? 1 : -1);
      return { at: (step + stops.length) % stops.length, wrapped: step < 0 || step >= stops.length };
    }
    const ahead = forward
      ? stops.findIndex((stop) => stop.range.start.isAfterOrEqual(selection.start))
      : stops.map((stop) => stop.range.start.isBefore(selection.start)).lastIndexOf(true);
    if (ahead !== -1) {
      return { at: ahead, wrapped: false };
    }
    return { at: forward ? 0 : stops.length - 1, wrapped: true };
  }

  private left(stops: Stop[], editor: vscode.TextEditor): number {
    const known = this.landedOn;
    if (
      !known ||
      known.uri !== editor.document.uri.toString() ||
      !editor.selection.isEmpty ||
      !editor.selection.start.isEqual(known.position)
    ) {
      return -1;
    }
    return stops.findIndex((stop) => stop.annotation.id === known.id);
  }

  private async land(editor: vscode.TextEditor, range: vscode.Range, id: string): Promise<boolean> {
    let target = editor;
    if (editor !== vscode.window.activeTextEditor) {
      try {
        target = await vscode.window.showTextDocument(editor.document, {
          viewColumn: editor.viewColumn,
          preserveFocus: false
        });
      } catch {
        void vscode.window.showWarningMessage("CodeLight could not open that file.");
        return false;
      }
    }
    target.selections = [new vscode.Selection(range.start, range.start)];
    target.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    this.landedOn = { uri: target.document.uri.toString(), position: range.start, id };
    return true;
  }

  private editor(): vscode.TextEditor | undefined {
    const active = vscode.window.activeTextEditor;
    if (this.mappable(active)) {
      this.tracked = active;
      return active;
    }
    if (this.mappable(this.tracked)) {
      return this.tracked;
    }
    this.tracked = vscode.window.visibleTextEditors.find((candidate) => this.mappable(candidate));
    return this.tracked;
  }

  private mappable(editor: vscode.TextEditor | undefined): editor is vscode.TextEditor {
    return editor !== undefined && this.store.relative(editor.document.uri) !== undefined;
  }

  private stopsIn(document: vscode.TextDocument, all: readonly Annotation[]): Stop[] {
    const key = `${document.uri.toString()}@${document.version}`;
    if (this.cacheKey === key && this.cached) {
      return this.cached;
    }
    const { spans, detached } = this.live.placedIn(document);
    const stops: Stop[] = [];
    for (const annotation of all) {
      if (annotation.orphaned === true || detached.has(annotation.id)) {
        continue;
      }
      stops.push({ annotation, range: this.live.rangeFor(document, annotation, spans) });
    }
    stops.sort(order);
    this.cached = stops;
    this.cacheKey = key;
    return stops;
  }

  private forget(): void {
    this.cached = undefined;
    this.cacheKey = "";
  }

  private say(stops: Stop[], skipped: number, at: number, wrapped: boolean): void {
    const where = `Highlight ${at + 1} of ${stops.length}`;
    const comments = stops[at].annotation.comments.length;
    const carried = comments === 0 ? "" : `, ${comments} comment${comments === 1 ? "" : "s"}`;
    const around = wrapped && stops.length > 1 ? ", back around" : "";
    const left = skipped === 0 ? "" : `, ${skipped} not in this version`;
    const seen = this.visibility.visible ? "" : ", notes hidden";
    vscode.window.setStatusBarMessage(
      `$(bookmark) ${where}${carried}${around}${left}${seen}`,
      3000
    );
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

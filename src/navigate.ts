import * as vscode from "vscode";
import { Annotation } from "./model";
import { LiveRanges } from "./live";
import { AnnotationStore } from "./store";

interface Stop {
  annotation: Annotation;
  range: vscode.Range;
}

function order(a: Stop, b: Stop): number {
  const start = a.range.start.compareTo(b.range.start);
  return start !== 0 ? start : a.range.end.compareTo(b.range.end);
}

export class Navigation {
  constructor(
    private readonly store: AnnotationStore,
    private readonly live: LiveRanges
  ) {}

  async step(forward: boolean): Promise<boolean> {
    const editor = vscode.window.activeTextEditor;
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
    const cursor = editor.selection.active;
    const ahead = forward
      ? stops.find((stop) => stop.range.start.isAfter(cursor))
      : [...stops].reverse().find((stop) => stop.range.start.isBefore(cursor));
    const target = ahead ?? (forward ? stops[0] : stops[stops.length - 1]);
    editor.selection = new vscode.Selection(target.range.start, target.range.end);
    editor.revealRange(target.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    this.say(stops, target, ahead === undefined);
    return true;
  }

  private stopsIn(document: vscode.TextDocument, all: readonly Annotation[]): Stop[] {
    const { spans, detached } = this.live.placedIn(document);
    const stops: Stop[] = [];
    for (const annotation of all) {
      if (annotation.orphaned === true || detached.has(annotation.id)) {
        continue;
      }
      stops.push({ annotation, range: this.live.rangeFor(document, annotation, spans) });
    }
    return stops.sort(order);
  }

  private say(stops: Stop[], target: Stop, wrapped: boolean): void {
    const at = stops.indexOf(target) + 1;
    const where = `Highlight ${at} of ${stops.length}`;
    const comments = target.annotation.comments.length;
    const carried =
      comments === 0 ? "" : `, ${comments} comment${comments === 1 ? "" : "s"}`;
    const around = wrapped && stops.length > 1 ? ", back around" : "";
    vscode.window.setStatusBarMessage(`$(bookmark) ${where}${carried}${around}`, 3000);
  }
}

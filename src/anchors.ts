import { Anchor } from "./model";

const ANCHOR_CONTEXT = 60;
const MAX_ANCHOR_TEXT = 400;

export interface Located {
  start: number;
  end: number;
}

function locate(text: string, needle: string, offset: number, length: number): Located | undefined {
  if (needle === "") {
    return undefined;
  }
  const first = text.indexOf(needle);
  if (first < 0 || first !== text.lastIndexOf(needle)) {
    return undefined;
  }
  return { start: first + offset, end: first + offset + length };
}

export function findAnchor(text: string, anchor: Anchor): Located | undefined {
  if (anchor.text === "") {
    return undefined;
  }
  const length = anchor.text.length;
  return (
    locate(text, `${anchor.before}${anchor.text}${anchor.after}`, anchor.before.length, length) ??
    locate(text, `${anchor.before}${anchor.text}`, anchor.before.length, length) ??
    locate(text, `${anchor.text}${anchor.after}`, 0, length) ??
    locate(text, anchor.text, 0, length)
  );
}

export function buildAnchor(text: string, start: number, end: number): Anchor {
  return {
    text: text.slice(start, end).slice(0, MAX_ANCHOR_TEXT),
    before: text.slice(Math.max(0, start - ANCHOR_CONTEXT), start),
    after: text.slice(end, end + ANCHOR_CONTEXT)
  };
}

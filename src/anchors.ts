import { Anchor } from "./model";

const ANCHOR_CONTEXT = 60;
const MAX_ANCHOR_TEXT = 400;

export function buildAnchor(text: string, start: number, end: number): Anchor {
  return {
    text: text.slice(start, end).slice(0, MAX_ANCHOR_TEXT),
    before: text.slice(Math.max(0, start - ANCHOR_CONTEXT), start),
    after: text.slice(end, end + ANCHOR_CONTEXT)
  };
}

export interface Span {
  start: number;
  end: number;
}

function shiftStart(
  point: number,
  start: number,
  end: number,
  delta: number,
  inserted: number
): number {
  if (point < start) {
    return point;
  }
  if (point >= end) {
    return point + delta;
  }
  return start + inserted;
}

function shiftEnd(point: number, start: number, end: number, delta: number): number {
  if (point <= start) {
    return point;
  }
  if (point >= end) {
    return point + delta;
  }
  return start;
}

export function shiftSpan(span: Span, start: number, end: number, inserted: number): Span {
  const delta = inserted - (end - start);
  const nextStart = shiftStart(span.start, start, end, delta, inserted);
  const nextEnd = shiftEnd(span.end, start, end, delta);
  return { start: nextStart, end: Math.max(nextStart, nextEnd) };
}

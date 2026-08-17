export interface Span {
  start: number;
  end: number;
}

function shiftStart(point: number, start: number, end: number, delta: number): number {
  if (point < start) {
    return point;
  }
  if (point >= end) {
    return point + delta;
  }
  return start;
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

export function shiftSpan(span: Span, start: number, end: number, delta: number): Span {
  const nextStart = shiftStart(span.start, start, end, delta);
  const nextEnd = shiftEnd(span.end, start, end, delta);
  return { start: nextStart, end: Math.max(nextStart, nextEnd) };
}

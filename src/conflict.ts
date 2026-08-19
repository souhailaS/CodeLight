import { Annotation, parseStore } from "./model";

const MINE = /^<{7}(?: .*)?$/;
const BASE = /^\|{7}(?: .*)?$/;
const SPLIT = /^={7}$/;
const THEIRS = /^>{7}(?: .*)?$/;

export function sidesOf(
  raw: string
): { mine: string; theirs: string; base: string | undefined } | undefined {
  const lines = raw.split(/\r?\n/);
  const mine: string[] = [];
  const theirs: string[] = [];
  const base: string[] = [];
  let where: "both" | "mine" | "base" | "theirs" = "both";
  let seen = false;
  let told = false;
  for (const line of lines) {
    if (MINE.test(line)) {
      if (where !== "both") {
        return undefined;
      }
      where = "mine";
      seen = true;
      continue;
    }
    if (BASE.test(line) && where === "mine") {
      where = "base";
      told = true;
      continue;
    }
    if (SPLIT.test(line) && (where === "mine" || where === "base")) {
      where = "theirs";
      continue;
    }
    if (THEIRS.test(line)) {
      if (where !== "theirs") {
        return undefined;
      }
      where = "both";
      continue;
    }
    if (where === "both") {
      mine.push(line);
      theirs.push(line);
      base.push(line);
      continue;
    }
    if (where === "mine") {
      mine.push(line);
      continue;
    }
    if (where === "theirs") {
      theirs.push(line);
      continue;
    }
    if (where === "base") {
      base.push(line);
    }
  }
  if (!seen || where !== "both") {
    return undefined;
  }
  return {
    mine: mine.join("\n"),
    theirs: theirs.join("\n"),
    base: told ? base.join("\n") : undefined
  };
}

function newer(a: Annotation, b: Annotation): Annotation {
  return b.updatedAt > a.updatedAt ? b : a;
}

function mergeRejected(a: Annotation, b: Annotation): unknown[] | undefined {
  const seen = new Set<string>();
  const kept: unknown[] = [];
  for (const entry of [...(a.rejectedComments ?? []), ...(b.rejectedComments ?? [])]) {
    const key = JSON.stringify(entry);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    kept.push(entry);
  }
  return kept.length === 0 ? undefined : kept;
}

function mergeComments(a: Annotation, b: Annotation): Annotation["comments"] {
  const merged = new Map(a.comments.map((comment) => [comment.id, comment]));
  for (const comment of b.comments) {
    const known = merged.get(comment.id);
    merged.set(comment.id, known && known.updatedAt > comment.updatedAt ? known : comment);
  }
  return [...merged.values()].sort((left, right) =>
    left.createdAt === right.createdAt
      ? left.id.localeCompare(right.id)
      : left.createdAt.localeCompare(right.createdAt)
  );
}

export interface Merged {
  annotations: Annotation[];
  rejected: unknown[];
  mine: number;
  theirs: number;
  dropped: number;
  sawBase: boolean;
}

export function mergeSides(raw: string): Merged | undefined {
  const sides = sidesOf(raw);
  if (!sides) {
    return undefined;
  }
  let mine;
  let theirs;
  try {
    mine = parseStore(sides.mine);
    theirs = parseStore(sides.theirs);
  } catch {
    return undefined;
  }
  let base;
  try {
    base = sides.base === undefined ? undefined : parseStore(sides.base);
  } catch {
    base = undefined;
  }
  const had = new Set(base?.annotations.map((entry) => entry.id) ?? []);
  const kept = new Set(mine.annotations.map((entry) => entry.id));
  const also = new Set(theirs.annotations.map((entry) => entry.id));
  const merged = new Map(mine.annotations.map((entry) => [entry.id, entry]));
  let dropped = 0;
  for (const entry of theirs.annotations) {
    const known = merged.get(entry.id);
    if (!known) {
      if (had.has(entry.id)) {
        dropped += 1;
        continue;
      }
      merged.set(entry.id, entry);
      continue;
    }
    merged.set(entry.id, {
      ...newer(known, entry),
      comments: mergeComments(known, entry),
      rejectedComments: mergeRejected(known, entry)
    });
  }
  for (const id of kept) {
    if (had.has(id) && !also.has(id)) {
      merged.delete(id);
      dropped += 1;
    }
  }
  for (const id of had) {
    if (!kept.has(id) && !also.has(id)) {
      dropped += 1;
    }
  }
  const rejected: unknown[] = [];
  const seenRejects = new Set<string>();
  for (const entry of [...mine.rejected, ...theirs.rejected]) {
    const key = JSON.stringify(entry);
    if (seenRejects.has(key)) {
      continue;
    }
    seenRejects.add(key);
    rejected.push(entry);
  }
  return {
    annotations: [...merged.values()],
    rejected,
    mine: mine.annotations.length,
    theirs: theirs.annotations.length,
    dropped,
    sawBase: base !== undefined
  };
}

export const STORE_VERSION = 1;
export const MAX_COMMENT_BODY = 2000;

export interface Author {
  login: string;
  id: string;
}

export interface Comment {
  id: string;
  author: Author;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface AnnotationRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

export interface Anchor {
  text: string;
  before: string;
  after: string;
}

export interface Annotation {
  id: string;
  file: string;
  range: AnnotationRange;
  anchor: Anchor;
  color: string;
  author: Author;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
  orphaned?: boolean;
  rejectedComments?: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function readLineNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function parseAuthor(value: unknown): Author | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const login = readString(value.login).trim();
  const id = readString(value.id).trim();
  if (login === "" || id === "") {
    return undefined;
  }
  return { login, id };
}

function parseRange(value: unknown): AnnotationRange {
  if (!isRecord(value)) {
    return { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0 };
  }
  const startLine = readLineNumber(value.startLine);
  const startCharacter = readLineNumber(value.startCharacter);
  const endLine = Math.max(startLine, readLineNumber(value.endLine));
  const rawEndCharacter = readLineNumber(value.endCharacter);
  const endCharacter =
    endLine === startLine ? Math.max(startCharacter, rawEndCharacter) : rawEndCharacter;
  return { startLine, startCharacter, endLine, endCharacter };
}

function parseAnchor(value: unknown): Anchor {
  if (!isRecord(value)) {
    return { text: "", before: "", after: "" };
  }
  return {
    text: readString(value.text),
    before: readString(value.before),
    after: readString(value.after)
  };
}

function parseComment(value: unknown): Comment | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = readString(value.id).trim();
  const author = parseAuthor(value.author);
  if (id === "" || !author) {
    return undefined;
  }
  const createdAt = readString(value.createdAt);
  return {
    id,
    author,
    body: readString(value.body),
    createdAt,
    updatedAt: readString(value.updatedAt, createdAt)
  };
}

export function isSafeRelativePath(candidate: string): boolean {
  if (candidate === "" || candidate.startsWith("/") || candidate.includes("\\")) {
    return false;
  }
  if (/^[a-zA-Z]:/.test(candidate)) {
    return false;
  }
  const segments = candidate.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

interface DropCounter {
  count: number;
}

function parseAnnotation(value: unknown, dropped: DropCounter): Annotation | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = readString(value.id).trim();
  const file = readString(value.file).trim();
  const author = parseAuthor(value.author);
  if (id === "" || !isSafeRelativePath(file) || !author) {
    return undefined;
  }
  const createdAt = readString(value.createdAt);
  const rawComments = Array.isArray(value.comments) ? value.comments : [];
  const seenComments = new Set<string>();
  const comments: Comment[] = [];
  const rejectedComments: unknown[] = [];
  for (const entry of rawComments) {
    const comment = parseComment(entry);
    if (!comment || seenComments.has(comment.id)) {
      dropped.count += 1;
      rejectedComments.push(entry);
      continue;
    }
    seenComments.add(comment.id);
    comments.push(comment);
  }
  return {
    id,
    file,
    range: parseRange(value.range),
    anchor: parseAnchor(value.anchor),
    color: readString(value.color, "yellow"),
    author,
    createdAt,
    updatedAt: readString(value.updatedAt, createdAt),
    orphaned: value.orphaned === true ? true : undefined,
    comments,
    rejectedComments
  };
}

export interface ParsedStore {
  annotations: Annotation[];
  dropped: number;
  rejected: unknown[];
}

export function parseStore(raw: string): ParsedStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("The file is not valid JSON.");
  }
  if (!isRecord(parsed)) {
    throw new Error("The file must contain an object.");
  }
  if (typeof parsed.version === "number" && parsed.version > STORE_VERSION) {
    throw new Error(
      `The file uses format version ${parsed.version}, this build understands ${STORE_VERSION}. Update the extension.`
    );
  }
  const rawAnnotations = Array.isArray(parsed.annotations) ? parsed.annotations : [];
  const seen = new Set<string>();
  const annotations: Annotation[] = [];
  const dropped: DropCounter = { count: 0 };
  const rejected: unknown[] = [];
  for (const entry of rawAnnotations) {
    const annotation = parseAnnotation(entry, dropped);
    if (!annotation || seen.has(annotation.id)) {
      dropped.count += 1;
      rejected.push(entry);
      continue;
    }
    seen.add(annotation.id);
    annotations.push(annotation);
  }
  return { annotations, dropped: dropped.count, rejected };
}

function sortAnnotations(annotations: readonly Annotation[]): Annotation[] {
  return [...annotations].sort((a, b) => {
    if (a.file !== b.file) {
      return a.file < b.file ? -1 : 1;
    }
    if (a.range.startLine !== b.range.startLine) {
      return a.range.startLine - b.range.startLine;
    }
    if (a.range.startCharacter !== b.range.startCharacter) {
      return a.range.startCharacter - b.range.startCharacter;
    }
    return a.id < b.id ? -1 : 1;
  });
}

function toWire(annotation: Annotation): Record<string, unknown> {
  const { rejectedComments, ...rest } = annotation;
  if (!rejectedComments || rejectedComments.length === 0) {
    return rest;
  }
  return { ...rest, comments: [...annotation.comments, ...rejectedComments] };
}

export function serializeStore(
  annotations: readonly Annotation[],
  rejected: readonly unknown[] = []
): string {
  const payload = {
    version: STORE_VERSION,
    annotations: [...sortAnnotations(annotations).map(toWire), ...rejected]
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

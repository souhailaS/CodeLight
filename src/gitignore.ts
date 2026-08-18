import { chmod, lstat, rename } from "node:fs/promises";
import * as vscode from "vscode";
import { newId } from "./ids";
import { exists, isMissingFile } from "./paths";

const HEADER = "# CodeLight notes, kept out of git";
const ENTRIES = [".vscode/codelight.json", ".vscode/codelight.json.gz"];

interface Ignore {
  uri: vscode.Uri;
  lines: string[];
  eol: string;
}

function pattern(line: string): string {
  return line.trim().replace(/^\/+/, "");
}

function isEntry(line: string): boolean {
  return ENTRIES.includes(pattern(line));
}

function isNegation(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("!") && ENTRIES.includes(pattern(trimmed.slice(1)));
}

function isHeader(line: string): boolean {
  return line.trim() === HEADER;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readIgnore(root: vscode.Uri): Promise<Ignore | undefined> {
  const uri = vscode.Uri.joinPath(root, ".gitignore");
  const open = vscode.workspace.textDocuments.find(
    (document) => document.uri.fsPath === uri.fsPath && document.isDirty
  );
  if (open) {
    void vscode.window.showWarningMessage(
      `Save ${uri.fsPath} first, CodeLight will not write over unsaved changes.`
    );
    return undefined;
  }
  let text = "";
  try {
    text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  } catch (error) {
    if (!isMissingFile(error)) {
      void vscode.window.showWarningMessage(`CodeLight could not read ${uri.fsPath}. ${describe(error)}`);
      return undefined;
    }
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text === "" ? [] : text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return { uri, lines, eol };
}

async function shared(target: vscode.Uri): Promise<{ mode: number } | undefined> {
  if (target.scheme !== "file") {
    return undefined;
  }
  try {
    const info = await lstat(target.fsPath);
    return info.isSymbolicLink() || info.nlink > 1 ? undefined : { mode: info.mode & 0o7777 };
  } catch {
    return { mode: 0o644 };
  }
}

async function writeIgnore(ignore: Ignore, lines: string[]): Promise<boolean> {
  const text = lines.length === 0 ? "" : `${lines.join(ignore.eol)}${ignore.eol}`;
  const bytes = Buffer.from(text, "utf8");
  const place = await shared(ignore.uri);
  if (place) {
    const folder = vscode.Uri.joinPath(ignore.uri, "..");
    const temporary = vscode.Uri.joinPath(folder, `.gitignore.codelight-${newId()}.tmp`);
    try {
      await vscode.workspace.fs.writeFile(temporary, bytes);
      await chmod(temporary.fsPath, place.mode);
      await rename(temporary.fsPath, ignore.uri.fsPath);
      return true;
    } catch (error) {
      try {
        await vscode.workspace.fs.delete(temporary);
      } catch {
        void error;
      }
    }
  }
  try {
    await vscode.workspace.fs.writeFile(ignore.uri, bytes);
    return true;
  } catch (error) {
    void vscode.window.showWarningMessage(`CodeLight could not write ${ignore.uri.fsPath}. ${describe(error)}`);
    return false;
  }
}

async function reveal(uri: vscode.Uri, message: string): Promise<void> {
  const chosen = await vscode.window.showInformationMessage(message, "Open .gitignore");
  if (chosen === "Open .gitignore") {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  }
}

export async function keepPrivate(root: vscode.Uri): Promise<void> {
  const ignore = await readIgnore(root);
  if (!ignore) {
    return;
  }
  const negated = ignore.lines.some(isNegation);
  const lines = ignore.lines.filter((line) => !isNegation(line));
  const present = new Set(lines.filter(isEntry).map(pattern));
  const missing = ENTRIES.filter((entry) => !present.has(entry));
  if (missing.length === 0 && !negated) {
    void vscode.window.showInformationMessage(
      `The CodeLight notes are already out of git, ${ignore.uri.fsPath} names them both.`
    );
    return;
  }
  const last = lines.reduce((found, line, index) => (isEntry(line) ? index : found), -1);
  if (last >= 0) {
    lines.splice(last + 1, 0, ...missing);
  } else if (missing.length > 0) {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== "") {
      lines.push("");
    }
    if (!lines.some(isHeader)) {
      lines.push(HEADER);
    }
    lines.push(...missing);
  }
  if (!(await writeIgnore(ignore, lines))) {
    return;
  }
  const repository = await exists(vscode.Uri.joinPath(root, ".git"));
  const note = repository
    ? "A file that git already tracks stays tracked until you run git rm --cached on it, and committing that removal takes the file out of everyone else's checkout too."
    : `${root.fsPath} is not a git repository yet, so the rule only takes effect once it becomes one.`;
  await reveal(ignore.uri, `CodeLight notes are now ignored by git. ${note}`);
}

export async function stopKeepingPrivate(root: vscode.Uri): Promise<void> {
  const ignore = await readIgnore(root);
  if (!ignore) {
    return;
  }
  if (!ignore.lines.some(isEntry)) {
    void vscode.window.showInformationMessage(
      `The CodeLight notes already go into git, nothing in ${ignore.uri.fsPath} keeps them out.`
    );
    return;
  }
  const drop = new Set<number>();
  ignore.lines.forEach((line, index) => {
    if (!isEntry(line)) {
      return;
    }
    drop.add(index);
    let above = index - 1;
    while (above >= 0 && (isEntry(ignore.lines[above]) || isHeader(ignore.lines[above]))) {
      if (isHeader(ignore.lines[above])) {
        drop.add(above);
        if (above > 0 && ignore.lines[above - 1].trim() === "") {
          drop.add(above - 1);
        }
        break;
      }
      above -= 1;
    }
  });
  const kept = ignore.lines.filter((_, index) => !drop.has(index));
  if (!(await writeIgnore(ignore, kept))) {
    return;
  }
  await reveal(
    ignore.uri,
    "CodeLight no longer asks git to ignore the notes. Another rule such as .vscode/* can still keep them out, so check git check-ignore if they do not show up."
  );
}

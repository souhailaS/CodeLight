import * as vscode from "vscode";
import { isMissingFile } from "./paths";

const HEADER = "# CodeLight notes, kept out of git";
const ENTRIES = [".vscode/codelight.json", ".vscode/codelight.json.gz"];

interface Ignore {
  uri: vscode.Uri;
  lines: string[];
  eol: string;
  final: boolean;
  existed: boolean;
}

function isEntry(line: string): boolean {
  const trimmed = line.trim().replace(/^\/+/, "");
  return ENTRIES.includes(trimmed);
}

function isHeader(line: string): boolean {
  return line.trim() === HEADER;
}

async function readIgnore(root: vscode.Uri): Promise<Ignore | undefined> {
  const uri = vscode.Uri.joinPath(root, ".gitignore");
  let text = "";
  let existed = true;
  try {
    text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  } catch (error) {
    if (!isMissingFile(error)) {
      void vscode.window.showWarningMessage(
        `CodeLight could not read ${uri.fsPath}. ${error instanceof Error ? error.message : String(error)}`
      );
      return undefined;
    }
    existed = false;
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const final = text === "" || text.endsWith(eol);
  const lines = text === "" ? [] : text.split(eol);
  if (final && lines.length > 0) {
    lines.pop();
  }
  return { uri, lines, eol, final, existed };
}

async function writeIgnore(ignore: Ignore, lines: string[]): Promise<boolean> {
  const text = lines.length === 0 ? "" : `${lines.join(ignore.eol)}${ignore.eol}`;
  try {
    await vscode.workspace.fs.writeFile(ignore.uri, Buffer.from(text, "utf8"));
    return true;
  } catch (error) {
    void vscode.window.showWarningMessage(
      `CodeLight could not write ${ignore.uri.fsPath}. ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

export async function keepPrivate(root: vscode.Uri): Promise<void> {
  const ignore = await readIgnore(root);
  if (!ignore) {
    return;
  }
  const missing = ENTRIES.filter(
    (entry) => !ignore.lines.some((line) => isEntry(line) && line.trim().replace(/^\/+/, "") === entry)
  );
  if (missing.length === 0) {
    void vscode.window.showInformationMessage(
      `${ignore.uri.fsPath} already keeps the CodeLight notes out of git.`
    );
    return;
  }
  const lines = [...ignore.lines];
  const last = lines.reduce((found, line, index) => (isEntry(line) ? index : found), -1);
  if (last >= 0) {
    lines.splice(last + 1, 0, ...missing);
  } else {
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
  const chosen = await vscode.window.showInformationMessage(
    "CodeLight notes are now ignored by git. A file that was already committed keeps being tracked until you run git rm --cached on it.",
    "Open .gitignore"
  );
  if (chosen === "Open .gitignore") {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(ignore.uri));
  }
}

export async function stopKeepingPrivate(root: vscode.Uri): Promise<void> {
  const ignore = await readIgnore(root);
  if (!ignore) {
    return;
  }
  if (!ignore.existed || !ignore.lines.some(isEntry)) {
    void vscode.window.showInformationMessage(
      "The CodeLight notes are not ignored by git, so they already travel with the repository."
    );
    return;
  }
  const kept = ignore.lines.filter((line) => !isEntry(line) && !isHeader(line));
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") {
    kept.pop();
  }
  if (!(await writeIgnore(ignore, kept))) {
    return;
  }
  const chosen = await vscode.window.showInformationMessage(
    "The CodeLight notes will go into git again. Commit the file in .vscode to share them.",
    "Open .gitignore"
  );
  if (chosen === "Open .gitignore") {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(ignore.uri));
  }
}

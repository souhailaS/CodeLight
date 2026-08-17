import * as vscode from "vscode";
import { isSafeRelativePath } from "./model";

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

export type StorageMode = "json" | "compressed";

const STORE_NAMES: Record<StorageMode, string> = {
  json: "codelight.json",
  compressed: "codelight.json.gz"
};

export const STORE_PATTERN = ".vscode/{codelight.json,codelight.json.gz}";

export function storeUri(root: vscode.Uri, mode: StorageMode): vscode.Uri {
  return vscode.Uri.joinPath(root, ".vscode", STORE_NAMES[mode]);
}

export function isMissingFile(error: unknown): boolean {
  if (error instanceof vscode.FileSystemError) {
    return error.code === "FileNotFound";
  }
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}

export async function statFile(target: vscode.Uri): Promise<vscode.FileStat | undefined> {
  try {
    return await vscode.workspace.fs.stat(target);
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function exists(target: vscode.Uri): Promise<boolean> {
  return (await statFile(target)) !== undefined;
}

async function hasStore(root: vscode.Uri): Promise<boolean> {
  try {
    if (await exists(storeUri(root, "json"))) {
      return true;
    }
    return await exists(storeUri(root, "compressed"));
  } catch {
    return false;
  }
}

export async function resolveRoot(preferred?: vscode.Uri): Promise<vscode.Uri | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  const stillOpen = preferred
    ? folders.find((folder) => folder.uri.toString() === preferred.toString())
    : undefined;
  if (stillOpen && (await hasStore(stillOpen.uri))) {
    return stillOpen.uri;
  }
  for (const folder of folders) {
    if (await hasStore(folder.uri)) {
      return folder.uri;
    }
  }
  if (stillOpen) {
    return stillOpen.uri;
  }
  const active = vscode.window.activeTextEditor;
  const activeFolder = active ? vscode.workspace.getWorkspaceFolder(active.document.uri) : undefined;
  return activeFolder ? activeFolder.uri : folders[0].uri;
}

function comparable(value: string): string {
  return CASE_INSENSITIVE ? value.toLowerCase() : value;
}

export function toRelativePath(root: vscode.Uri, target: vscode.Uri): string | undefined {
  if (target.scheme !== root.scheme || comparable(target.authority) !== comparable(root.authority)) {
    return undefined;
  }
  const rootPath = root.path.endsWith("/") ? root.path : `${root.path}/`;
  if (comparable(target.path.slice(0, rootPath.length)) !== comparable(rootPath)) {
    return undefined;
  }
  const relative = target.path.slice(rootPath.length);
  return isSafeRelativePath(relative) ? relative : undefined;
}

export function toUri(root: vscode.Uri, relativePath: string): vscode.Uri | undefined {
  if (!isSafeRelativePath(relativePath)) {
    return undefined;
  }
  return vscode.Uri.joinPath(root, ...relativePath.split("/"));
}

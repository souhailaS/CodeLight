import * as vscode from "vscode";
import { isSafeRelativePath } from "./model";

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

export function storeUri(root: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(root, ".vscode", "codelight.json");
}

async function hasStore(root: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(storeUri(root));
    return true;
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

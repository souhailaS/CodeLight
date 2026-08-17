import * as vscode from "vscode";
import { isSafeRelativePath } from "./model";

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

export function storeUri(root: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(root, ".vscode", "codelight.json");
}

export async function resolveRoot(): Promise<vscode.Uri | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  for (const folder of folders) {
    try {
      await vscode.workspace.fs.stat(storeUri(folder.uri));
      return folder.uri;
    } catch {
      continue;
    }
  }
  return folders[0].uri;
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
  return target.path.slice(rootPath.length);
}

export function toUri(root: vscode.Uri, relativePath: string): vscode.Uri | undefined {
  if (!isSafeRelativePath(relativePath)) {
    return undefined;
  }
  return vscode.Uri.joinPath(root, ...relativePath.split("/"));
}

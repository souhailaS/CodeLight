import * as vscode from "vscode";
import { isSafeRelativePath } from "./model";

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

export function workspaceRoot(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

export function storeUri(root: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(root, ".vscode", "codelight.json");
}

function comparable(value: string): string {
  return CASE_INSENSITIVE ? value.toLowerCase() : value;
}

export function toRelativePath(root: vscode.Uri, target: vscode.Uri): string | undefined {
  if (target.scheme !== root.scheme || comparable(target.authority) !== comparable(root.authority)) {
    return undefined;
  }
  const rootPath = root.path.endsWith("/") ? root.path : `${root.path}/`;
  if (!comparable(target.path).startsWith(comparable(rootPath))) {
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

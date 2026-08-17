import * as vscode from "vscode";

export function workspaceRoot(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

export function storeUri(root: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(root, ".vscode", "codelight.json");
}

export function toRelativePath(root: vscode.Uri, target: vscode.Uri): string | undefined {
  if (target.scheme !== root.scheme || target.authority !== root.authority) {
    return undefined;
  }
  const rootPath = root.path.endsWith("/") ? root.path : `${root.path}/`;
  if (!target.path.startsWith(rootPath)) {
    return undefined;
  }
  return target.path.slice(rootPath.length);
}

export function toUri(root: vscode.Uri, relativePath: string): vscode.Uri {
  return vscode.Uri.joinPath(root, ...relativePath.split("/"));
}

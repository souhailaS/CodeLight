import { chmod, lstat, rename } from "node:fs/promises";
import * as vscode from "vscode";
import { newId } from "./ids";

export const TEMPORARY_NAME = /^codelight\.write-.+\.tmp$/;

export interface TargetInfo {
  shared: boolean;
  mode: number;
}

export function temporaryName(): string {
  return `codelight.write-${newId()}.tmp`;
}

export function isPermissionDenied(error: unknown): boolean {
  if (error instanceof vscode.FileSystemError) {
    return error.code === "NoPermissions";
  }
  const code = typeof error === "object" && error !== null ? (error as { code?: string }).code : undefined;
  return code === "EACCES" || code === "EPERM" || code === "EROFS";
}

export async function inspectTarget(target: vscode.Uri): Promise<TargetInfo | undefined> {
  if (target.scheme !== "file") {
    return undefined;
  }
  try {
    const info = await lstat(target.fsPath);
    return { shared: info.isSymbolicLink() || info.nlink > 1, mode: info.mode & 0o7777 };
  } catch {
    return undefined;
  }
}

async function discard(temporary: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(temporary);
  } catch {
    return;
  }
}

export async function writeThroughTemporary(
  target: vscode.Uri,
  bytes: Uint8Array,
  scratch: vscode.Uri,
  onInPlace: () => void
): Promise<void> {
  await vscode.workspace.fs.createDirectory(scratch);
  const existing = await inspectTarget(target);
  if (target.scheme !== "file" || existing?.shared) {
    await vscode.workspace.fs.writeFile(target, bytes);
    return;
  }
  const temporary = vscode.Uri.joinPath(scratch, temporaryName());
  try {
    await vscode.workspace.fs.writeFile(temporary, bytes);
  } catch (error) {
    if (!isPermissionDenied(error)) {
      await discard(temporary);
      throw error;
    }
    await vscode.workspace.fs.writeFile(target, bytes);
    onInPlace();
    return;
  }
  try {
    if (existing) {
      await chmod(temporary.fsPath, existing.mode);
    }
    await rename(temporary.fsPath, target.fsPath);
  } catch (error) {
    await discard(temporary);
    throw error;
  }
}

import * as vscode from "vscode";

export async function rescue(body: string): Promise<boolean> {
  try {
    await vscode.env.clipboard.writeText(body);
    return true;
  } catch {
    return false;
  }
}

export function withRescue(message: string, rescued: boolean): string {
  return rescued ? `${message} Your comment was copied to the clipboard.` : message;
}

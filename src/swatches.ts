import * as vscode from "vscode";
import { PaletteColor } from "./palette";

const HEX = /^#[0-9a-fA-F]{6}$/;

export class Swatches {
  private readonly made = new Map<string, vscode.Uri>();

  constructor(private readonly storage: vscode.Uri) {}

  async iconFor(color: PaletteColor): Promise<vscode.Uri | undefined> {
    if (!HEX.test(color.hex)) {
      return undefined;
    }
    const key = color.hex.toLowerCase();
    const cached = this.made.get(key);
    if (cached) {
      return cached;
    }
    const target = vscode.Uri.joinPath(this.storage, "swatches", `${key.slice(1)}.svg`);
    const body = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="5.5" fill="${key}"/></svg>\n`;
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.storage, "swatches"));
      await vscode.workspace.fs.writeFile(target, Buffer.from(body, "utf8"));
    } catch {
      return undefined;
    }
    this.made.set(key, target);
    return target;
  }
}

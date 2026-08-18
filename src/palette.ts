import * as vscode from "vscode";
import { StorageMode } from "./paths";
import { InlineMode } from "./thread";

export type GutterMode = "always" | "highlights" | "off";

export interface PaletteColor {
  id: string;
  label: string;
  hex: string;
}

export const DEFAULT_PALETTE: readonly PaletteColor[] = [
  { id: "yellow", label: "Yellow", hex: "#ffd54f" },
  { id: "green", label: "Green", hex: "#81c784" },
  { id: "blue", label: "Blue", hex: "#64b5f6" },
  { id: "purple", label: "Purple", hex: "#ba68c8" },
  { id: "pink", label: "Pink", hex: "#f06292" },
  { id: "orange", label: "Orange", hex: "#ffb74d" }
];

export const DEFAULT_OPACITY = 0.3;

const HEX = /^#[0-9a-fA-F]{6}$/;

function configuration(resource?: vscode.Uri): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("codelight", resource ?? null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseColor(value: unknown): PaletteColor | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const hex = typeof value.hex === "string" ? value.hex.trim() : "";
  if (id === "" || !HEX.test(hex)) {
    return undefined;
  }
  const raw = typeof value.label === "string" ? value.label.replace(/\$\(/g, "(").trim() : "";
  const label = raw === "" ? id : raw;
  return { id, label, hex };
}

export function readPalette(resource?: vscode.Uri): PaletteColor[] {
  const configured = configuration(resource).get<unknown>("palette");
  if (!Array.isArray(configured) || configured.length === 0) {
    return [...DEFAULT_PALETTE];
  }
  const seen = new Set<string>();
  const palette: PaletteColor[] = [];
  for (const entry of configured) {
    const color = parseColor(entry);
    if (!color || seen.has(color.id)) {
      continue;
    }
    seen.add(color.id);
    palette.push(color);
  }
  return palette.length > 0 ? palette : [...DEFAULT_PALETTE];
}

export function readOpacity(resource?: vscode.Uri): number {
  const configured = configuration(resource).get<unknown>("highlightOpacity");
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_OPACITY;
  }
  return Math.min(1, Math.max(0.05, configured));
}

export function readInlineMode(resource?: vscode.Uri): InlineMode {
  const configured = configuration(resource).get<unknown>("inlineComments");
  return configured === "off" || configured === "count" || configured === "preview"
    ? configured
    : "preview";
}

export function readGutterMode(resource?: vscode.Uri): GutterMode {
  const configured = configuration(resource).get<unknown>("commentGutter");
  return configured === "highlights" || configured === "off" ? configured : "always";
}

export function readGutterMarks(resource?: vscode.Uri): boolean {
  return configuration(resource).get<unknown>("gutterMarks") !== false;
}

export function readStorageMode(resource?: vscode.Uri): StorageMode {
  const configured = configuration(resource).get<unknown>("storage");
  return configured === "compressed" ? "compressed" : "json";
}

export function resolveColor(palette: readonly PaletteColor[], id: string): PaletteColor {
  return palette.find((color) => color.id === id) ?? palette[0] ?? DEFAULT_PALETTE[0];
}

export function toRgba(hex: string, alpha: number): string {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

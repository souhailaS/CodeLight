import * as vscode from "vscode";
import { Annotation } from "./model";

const TRUSTED_COMMANDS = ["codelight.reply", "codelight.editComment", "codelight.deleteComment"];
const PREVIEW_LENGTH = 40;

export type InlineMode = "off" | "count" | "preview";

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
}

function commandLink(command: string, id: string, label: string): string {
  const args = encodeURIComponent(JSON.stringify([id]))
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
  return `[${label}](command:${command}?${args})`;
}

export function threadMarkdown(annotation: Annotation): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  markdown.isTrusted = { enabledCommands: TRUSTED_COMMANDS };
  markdown.supportThemeIcons = true;
  markdown.appendMarkdown(`$(comment) **CodeLight**\n\n`);
  if (annotation.comments.length === 0) {
    markdown.appendMarkdown(`_Highlighted by_ `);
    markdown.appendText(`@${annotation.author.login}`);
    markdown.appendMarkdown("\n\n");
  }
  for (const comment of annotation.comments) {
    const when = formatDate(comment.createdAt);
    markdown.appendText(`@${comment.author.login}`);
    markdown.appendMarkdown(when === "" ? "\n\n" : ` · ${when}\n\n`);
    markdown.appendText(comment.body);
    markdown.appendMarkdown("\n\n");
  }
  const actions = [commandLink("codelight.reply", annotation.id, "Reply")];
  if (annotation.comments.length > 0) {
    actions.push(commandLink("codelight.editComment", annotation.id, "Edit"));
    actions.push(commandLink("codelight.deleteComment", annotation.id, "Delete"));
  }
  markdown.appendMarkdown(actions.join(" · "));
  return markdown;
}

export function inlineLabel(annotation: Annotation, mode: InlineMode): string | undefined {
  if (mode === "off" || annotation.comments.length === 0) {
    return undefined;
  }
  const count = annotation.comments.length;
  if (mode === "count") {
    return count === 1 ? " 1 comment" : ` ${count} comments`;
  }
  const last = annotation.comments[count - 1];
  const body = last.body.replace(/\s+/g, " ").trim();
  const preview = body.length > PREVIEW_LENGTH ? `${body.slice(0, PREVIEW_LENGTH)}…` : body;
  const suffix = count > 1 ? ` (+${count - 1})` : "";
  return ` ${last.author.login}: ${preview}${suffix}`;
}

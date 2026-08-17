import { randomUUID } from "node:crypto";

export function newId(): string {
  return randomUUID();
}

export function timestamp(): string {
  return new Date().toISOString();
}

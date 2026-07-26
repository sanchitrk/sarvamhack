import { access, mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

export const maxUploadBytes = 5 * 1024 * 1024;

const allowedExtensions = new Set([
  ".css",
  ".csv",
  ".go",
  ".htm",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".py",
  ".rs",
  ".sql",
  ".text",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

export function isSessionId(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value);
}

export function uploadName(value: string): string {
  const original = basename(value).normalize("NFKC");
  const extension = extname(original).toLowerCase();
  if (!allowedExtensions.has(extension)) {
    throw new Error(`Unsupported file type "${extension || "unknown"}"`);
  }

  const stem = original
    .slice(0, -extension.length)
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 90);
  return `${stem || "upload"}${extension}`;
}

export function workspacePath(workspacesDir: string, sessionId: string): string {
  if (!isSessionId(sessionId)) throw new Error("Invalid session ID");
  return join(workspacesDir, sessionId);
}

export async function storeUpload(
  workspacesDir: string,
  sessionId: string,
  originalName: string,
  bytes: Uint8Array,
): Promise<string> {
  if (bytes.byteLength > maxUploadBytes) throw new Error("File exceeds the 5 MB limit");

  const workspace = workspacePath(workspacesDir, sessionId);
  await mkdir(workspace, { recursive: true });
  const safeName = uploadName(originalName);
  const extension = extname(safeName);
  const stem = safeName.slice(0, -extension.length);
  let candidate = safeName;

  for (let index = 2; ; index += 1) {
    try {
      await access(join(workspace, candidate));
      candidate = `${stem}-${index}${extension}`;
    } catch {
      break;
    }
  }

  await writeFile(join(workspace, candidate), bytes, { flag: "wx" });
  return candidate;
}

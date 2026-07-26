import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isSessionId, storeUpload, uploadName } from "../src/storage.ts";

describe("upload storage", () => {
  it("sanitizes supported filenames and rejects unsafe input", () => {
    expect(uploadName("../../Hackathon notes.md")).toBe("Hackathon-notes.md");
    expect(() => uploadName("archive.zip")).toThrow("Unsupported file type");
    expect(isSessionId("session-123")).toBe(true);
    expect(isSessionId("../session")).toBe(false);
  });

  it("keeps uploads isolated and does not overwrite an existing file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vaani-upload-"));
    const bytes = new TextEncoder().encode("important context");

    const first = await storeUpload(root, "session-1", "notes.txt", bytes);
    const second = await storeUpload(root, "session-1", "notes.txt", bytes);

    expect(first).toBe("notes.txt");
    expect(second).toBe("notes-2.txt");
    await expect(readFile(join(root, "session-1", first), "utf8")).resolves.toBe(
      "important context",
    );
  });
});

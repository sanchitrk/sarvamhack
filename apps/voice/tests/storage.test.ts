import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isSessionId, storeUpload, uploadName } from "../src/storage.ts";

describe("upload storage", () => {
  it("sanitizes filenames without deciding which formats the agent can read", () => {
    expect(uploadName("../../Hackathon notes.md")).toBe("Hackathon-notes.md");
    expect(uploadName("archive.zip")).toBe("archive.zip");
    expect(uploadName("README")).toBe("README");
    expect(isSessionId("session-123")).toBe(true);
    expect(isSessionId("../session")).toBe(false);
  });

  it("keeps uploads isolated and does not overwrite an existing file", async () => {
    const root = await mkdtemp(join(tmpdir(), "sia-upload-"));
    const bytes = new TextEncoder().encode("important context");

    const first = await storeUpload(root, "session-1", "notes.txt", bytes);
    const second = await storeUpload(root, "session-1", "notes.txt", bytes);
    const noExtension = await storeUpload(root, "session-1", "README", bytes);
    const duplicateNoExtension = await storeUpload(root, "session-1", "README", bytes);

    expect(first).toBe("notes.txt");
    expect(second).toBe("notes-2.txt");
    expect(noExtension).toBe("README");
    expect(duplicateNoExtension).toBe("README-2");
    await expect(readFile(join(root, "session-1", first), "utf8")).resolves.toBe(
      "important context",
    );
  });
});

import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";

import { digitizeDocument } from "../src/tools/document.ts";

const temporaryDirectories: string[] = [];

async function temporaryWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sarvamhack-document-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function fakeClient(
  archive: Uint8Array,
  state: "Completed" | "Failed" | "PartiallyCompleted" = "Completed",
) {
  const status = {
    job_id: "job-1",
    job_state: state,
    created_at: "2026-07-26T00:00:00Z",
    updated_at: "2026-07-26T00:00:01Z",
    storage_container_type: "Azure" as const,
    error_message: state === "Failed" ? "bad scan" : "",
  };
  const job = {
    jobId: "job-1",
    uploadFile: vi.fn(async () => {}),
    start: vi.fn(async () => status),
    getStatus: vi.fn(async () => status),
    getPageMetrics: vi.fn(() => ({
      totalPages: 1,
      pagesProcessed: 1,
      pagesSucceeded: state === "Failed" ? 0 : 1,
      pagesFailed: state === "Failed" ? 1 : 0,
      pageErrors: [],
    })),
    downloadOutput: vi.fn(async (path: string) => {
      await writeFile(path, archive);
      return path;
    }),
  };
  const createJob = vi.fn(async () => job);
  return {
    client: { documentIntelligence: { createJob } },
    createJob,
    job,
  };
}

describe("Sarvam Document Intelligence", () => {
  it("digitizes a workspace PDF and returns Markdown from the output archive", async () => {
    const cwd = await temporaryWorkspace();
    await writeFile(join(cwd, "invoice.pdf"), "fake pdf");
    const archive = zipSync({
      "invoice.md": strToU8("# Invoice\n\nTotal: ₹100"),
      "invoice.json": strToU8('{"pages":[]}'),
    });
    const fake = fakeClient(archive);

    const result = await digitizeDocument("invoice.pdf", "hi-IN", {
      client: fake.client,
      cwd,
      pollingIntervalMs: 0,
    });

    expect(result.content).toBe("# Invoice\n\nTotal: ₹100");
    expect(result).toMatchObject({
      fileName: "invoice.pdf",
      jobId: "job-1",
      pagesSucceeded: 1,
    });
    expect(fake.createJob).toHaveBeenCalledWith({
      language: "hi-IN",
      outputFormat: "md",
    });
    expect(fake.job.uploadFile).toHaveBeenCalledWith(await realpath(join(cwd, "invoice.pdf")));
  });

  it("rejects files outside the agent workspace", async () => {
    const root = await temporaryWorkspace();
    const cwd = join(root, "workspace");
    await mkdir(cwd);
    await writeFile(join(root, "private.pdf"), "fake pdf");

    await expect(
      digitizeDocument("../private.pdf", "en-IN", {
        client: fakeClient(zipSync({ "output.md": strToU8("text") })).client,
        cwd,
      }),
    ).rejects.toThrow("inside the current workspace");
  });

  it("surfaces failed Sarvam jobs without downloading output", async () => {
    const cwd = await temporaryWorkspace();
    await writeFile(join(cwd, "scan.png"), "fake image");
    const fake = fakeClient(zipSync({ "output.md": strToU8("text") }), "Failed");

    await expect(
      digitizeDocument("scan.png", "en-IN", {
        client: fake.client,
        cwd,
        pollingIntervalMs: 0,
      }),
    ).rejects.toThrow("bad scan");
    expect(fake.job.downloadOutput).not.toHaveBeenCalled();
  });
});

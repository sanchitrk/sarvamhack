import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { splitPdf } from "../src/tools/pdf.ts";

const temporaryDirectories: string[] = [];

function pdfWithPages(pageCount: number): string {
  const pageObjects = Array.from({ length: pageCount }, (_, index) => `${index + 3} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageObjects}] /Count ${pageCount} >>`,
    ...Array.from(
      { length: pageCount },
      () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>",
    ),
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(pdf);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

async function temporaryWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sarvamhack-pdf-test-"));
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

describe("PDF splitting", () => {
  it("creates ordered Poppler chunks inside the workspace", async () => {
    const cwd = await temporaryWorkspace();
    await writeFile(join(cwd, "report.pdf"), pdfWithPages(5));

    const result = await splitPdf("report.pdf", { cwd, pagesPerPart: 2 });

    expect(result.totalPages).toBe(5);
    expect(result.pagesPerPart).toBe(2);
    expect(result.parts).toHaveLength(3);
    expect(result.parts.map((part) => part.split("/").at(-1))).toEqual([
      "part-001.pdf",
      "part-002.pdf",
      "part-003.pdf",
    ]);
  });

  it("rejects PDFs outside the workspace", async () => {
    const root = await temporaryWorkspace();
    const cwd = await temporaryWorkspace();
    await writeFile(join(root, "private.pdf"), pdfWithPages(1));

    await expect(splitPdf(join(root, "private.pdf"), { cwd })).rejects.toThrow(
      "inside the current workspace",
    );
  });
});

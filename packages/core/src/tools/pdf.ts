import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, extname, isAbsolute, join, parse, relative, resolve } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

export const PDF_SPLIT_TOOL_NAME = "split_pdf";

const run = promisify(execFile);
const parameters = Type.Object({
  path: Type.String({
    description: "Path to a PDF in the current workspace.",
  }),
  pagesPerPart: Type.Optional(
    Type.Integer({
      default: 10,
      description: "Maximum pages in each output PDF. Defaults to 10.",
      minimum: 1,
      maximum: 10,
    }),
  ),
});

export interface SplitPdfOptions {
  cwd: string;
  pagesPerPart?: number;
  signal?: AbortSignal;
}

export interface SplitPdfResult {
  pagesPerPart: number;
  parts: string[];
  sourcePath: string;
  totalPages: number;
}

async function workspacePdf(cwd: string, inputPath: string): Promise<string> {
  const workspace = await realpath(cwd);
  const candidate = await realpath(resolve(workspace, inputPath));
  const fromWorkspace = relative(workspace, candidate);
  if (fromWorkspace.startsWith("..") || isAbsolute(fromWorkspace)) {
    throw new Error("PDF path must be inside the current workspace");
  }
  if (extname(candidate).toLowerCase() !== ".pdf" || !(await stat(candidate)).isFile()) {
    throw new Error("PDF path must point to a .pdf file");
  }
  return candidate;
}

async function poppler(command: string, args: string[], signal?: AbortSignal): Promise<void> {
  try {
    await run(command, args, { signal });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Poppler command "${command}" is unavailable`);
    }
    throw error;
  }
}

export async function splitPdf(
  inputPath: string,
  options: SplitPdfOptions,
): Promise<SplitPdfResult> {
  const sourcePath = await workspacePdf(options.cwd, inputPath);
  const source = await stat(sourcePath);
  const pagesPerPart = options.pagesPerPart ?? (source.size > 200 * 1024 * 1024 ? 1 : 10);
  if (!Number.isInteger(pagesPerPart) || pagesPerPart < 1 || pagesPerPart > 10) {
    throw new Error("pagesPerPart must be an integer from 1 to 10");
  }

  const stem = parse(sourcePath).name;
  const outputDirectory = await mkdtemp(join(dirname(sourcePath), `${stem}-parts-`));
  const pageDirectory = join(outputDirectory, ".pages");
  await mkdir(pageDirectory);

  try {
    await poppler("pdfseparate", [sourcePath, join(pageDirectory, "page-%d.pdf")], options.signal);
    const pageNames = (await readdir(pageDirectory))
      .map((name) => ({ name, number: Number(/^page-(\d+)\.pdf$/.exec(name)?.[1]) }))
      .filter((page) => Number.isInteger(page.number))
      .sort((left, right) => left.number - right.number);
    if (pageNames.length === 0) throw new Error("Poppler found no pages in the PDF");

    const parts: string[] = [];
    for (let index = 0; index < pageNames.length; index += pagesPerPart) {
      const pagePaths = pageNames
        .slice(index, index + pagesPerPart)
        .map((page) => join(pageDirectory, page.name));
      const partPath = join(
        outputDirectory,
        `part-${String(parts.length + 1).padStart(3, "0")}.pdf`,
      );
      if (pagePaths.length === 1) {
        await copyFile(pagePaths[0] as string, partPath);
      } else {
        await poppler("pdfunite", [...pagePaths, partPath], options.signal);
      }
      parts.push(relative(await realpath(options.cwd), partPath));
    }

    return {
      pagesPerPart,
      parts,
      sourcePath,
      totalPages: pageNames.length,
    };
  } catch (error) {
    await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(pageDirectory, { recursive: true, force: true });
  }
}

export function createPdfSplitTool() {
  return defineTool({
    name: PDF_SPLIT_TOOL_NAME,
    label: "Split PDF",
    description:
      "Split a workspace PDF into ordered Poppler-generated PDFs of at most 10 pages each.",
    promptSnippet:
      "Split an oversized or over-10-page PDF into ordered parts before document processing.",
    promptGuidelines: [
      "When Document Intelligence rejects a PDF for page count or file size, call split_pdf and submit every returned part to document_intelligence in order.",
    ],
    parameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      const result = await splitPdf(params.path, {
        cwd: context.cwd,
        pagesPerPart: params.pagesPerPart,
        signal,
      });
      return {
        content: [
          {
            type: "text",
            text: `Created ${result.parts.length} ordered PDF parts:\n${result.parts.join("\n")}`,
          },
        ],
        details: result,
      };
    },
  });
}

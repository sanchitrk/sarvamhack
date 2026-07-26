import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";

import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { strFromU8, unzipSync } from "fflate";
import { SarvamAIClient } from "sarvamai";

export const DOCUMENT_INTELLIGENCE_TOOL_NAME = "document_intelligence";

const maxDocumentBytes = 200 * 1024 * 1024;
const supportedExtensions = new Set([".jpeg", ".jpg", ".pdf", ".png", ".zip"]);
const terminalStates = new Set(["Completed", "PartiallyCompleted", "Failed"]);
const languages = [
  "as-IN",
  "bn-IN",
  "bodo-IN",
  "doi-IN",
  "en-IN",
  "gu-IN",
  "hi-IN",
  "kn-IN",
  "kok-IN",
  "ks-IN",
  "mai-IN",
  "ml-IN",
  "mni-IN",
  "mr-IN",
  "ne-IN",
  "or-IN",
  "pa-IN",
  "sa-IN",
  "sat-IN",
  "sd-IN",
  "ta-IN",
  "te-IN",
  "ur-IN",
] as const;

const parameters = Type.Object({
  path: Type.String({
    description: "Path to a PDF, PNG, JPEG, or ZIP of document page images in the workspace.",
  }),
  language: Type.Optional(
    StringEnum(languages, {
      default: "en-IN",
      description: "Primary document language. Defaults to Indian English (en-IN).",
    }),
  ),
});

type SarvamJob = Awaited<ReturnType<SarvamAIClient["documentIntelligence"]["createJob"]>>;
type SarvamJobStatus = Awaited<ReturnType<SarvamJob["start"]>>;

interface DocumentJob {
  readonly jobId: string;
  downloadOutput(path: string): Promise<string>;
  getPageMetrics(): ReturnType<SarvamJob["getPageMetrics"]>;
  getStatus(): Promise<SarvamJobStatus>;
  start(): Promise<SarvamJobStatus>;
  uploadFile(path: string): Promise<void>;
}

interface DocumentClient {
  documentIntelligence: {
    createJob(
      options: Parameters<SarvamAIClient["documentIntelligence"]["createJob"]>[0],
    ): Promise<DocumentJob>;
  };
}

export interface DigitizeDocumentOptions {
  apiKey?: string;
  client?: DocumentClient;
  cwd: string;
  maxPollingAttempts?: number;
  pollingIntervalMs?: number;
  signal?: AbortSignal;
  onStatus?: (status: string) => void | Promise<void>;
}

export interface DigitizedDocument {
  content: string;
  fileName: string;
  jobId: string;
  jobState: string;
  pagesFailed: number;
  pagesSucceeded: number;
  sourcePath: string;
}

function abortError(): Error {
  const error = new Error("Document intelligence was cancelled");
  error.name = "AbortError";
  return error;
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

async function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  checkAborted(signal);
  await new Promise<void>((resolveWait, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveWait();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function workspaceFile(cwd: string, inputPath: string): Promise<string> {
  const workspace = await realpath(cwd);
  const candidate = await realpath(resolve(workspace, inputPath));
  const fromWorkspace = relative(workspace, candidate);
  if (fromWorkspace.startsWith("..") || isAbsolute(fromWorkspace)) {
    throw new Error("Document path must be inside the current workspace");
  }
  return candidate;
}

function archiveText(bytes: Uint8Array): string {
  const entries = Object.entries(unzipSync(bytes))
    .filter(([name]) => !name.endsWith("/") && !name.includes("__MACOSX"))
    .sort(([left], [right]) => left.localeCompare(right));
  const preferred = entries.filter(([name]) => name.toLowerCase().endsWith(".md"));
  const readable =
    preferred.length > 0
      ? preferred
      : entries.filter(([name]) => /\.(?:html?|json|txt)$/i.test(name));

  if (readable.length === 0) {
    throw new Error("Sarvam returned no readable Markdown, HTML, JSON, or text output");
  }

  return readable
    .map(([name, content]) => {
      const text = strFromU8(content).trim();
      return readable.length === 1 ? text : `## ${name}\n\n${text}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

export async function digitizeDocument(
  inputPath: string,
  language: (typeof languages)[number] = "en-IN",
  options: DigitizeDocumentOptions,
): Promise<DigitizedDocument> {
  const sourcePath = await workspaceFile(options.cwd, inputPath);
  const extension = extname(sourcePath).toLowerCase();
  if (!supportedExtensions.has(extension)) {
    throw new Error("Sarvam Document Intelligence accepts PDF, PNG, JPEG, or ZIP files");
  }

  const metadata = await stat(sourcePath);
  if (!metadata.isFile()) throw new Error("Document path must point to a file");
  if (metadata.size > maxDocumentBytes) {
    throw new Error("Document exceeds Sarvam's 200 MB file limit");
  }

  const apiKey = options.apiKey?.trim();
  if (!options.client && !apiKey) throw new Error("SARVAM_API_KEY is required");
  const client = options.client || new SarvamAIClient({ apiSubscriptionKey: apiKey as string });
  const pollingIntervalMs = options.pollingIntervalMs ?? 2_000;
  const maxPollingAttempts = options.maxPollingAttempts ?? 150;

  checkAborted(options.signal);
  const job = await client.documentIntelligence.createJob({
    language,
    outputFormat: "md",
  });
  await options.onStatus?.(`Created Sarvam job ${job.jobId}`);

  checkAborted(options.signal);
  await job.uploadFile(sourcePath);
  await options.onStatus?.(`Uploaded ${basename(sourcePath)}`);

  checkAborted(options.signal);
  let status = await job.start();
  await options.onStatus?.(`Sarvam job is ${status.job_state}`);

  let attempts = 0;
  while (!terminalStates.has(status.job_state) && attempts < maxPollingAttempts) {
    await wait(pollingIntervalMs, options.signal);
    status = await job.getStatus();
    attempts += 1;
    await options.onStatus?.(
      `Sarvam job is ${status.job_state} (${job.getPageMetrics().pagesProcessed} pages processed)`,
    );
  }

  if (!terminalStates.has(status.job_state)) {
    throw new Error(
      `Sarvam job did not complete within ${(pollingIntervalMs * maxPollingAttempts) / 1_000} seconds`,
    );
  }
  if (status.job_state === "Failed") {
    throw new Error(status.error_message || "Sarvam Document Intelligence job failed");
  }

  checkAborted(options.signal);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "sarvam-document-"));
  const archivePath = join(temporaryDirectory, "output.zip");
  try {
    await job.downloadOutput(archivePath);
    checkAborted(options.signal);
    const content = archiveText(await readFile(archivePath));
    const metrics = job.getPageMetrics();
    return {
      content,
      fileName: basename(sourcePath),
      jobId: job.jobId,
      jobState: status.job_state,
      pagesFailed: metrics.pagesFailed,
      pagesSucceeded: metrics.pagesSucceeded,
      sourcePath,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export function createDocumentIntelligenceTool(
  options: Omit<DigitizeDocumentOptions, "cwd" | "signal" | "onStatus">,
) {
  return defineTool({
    name: DOCUMENT_INTELLIGENCE_TOOL_NAME,
    label: "Sarvam Document Intelligence",
    description:
      "Digitize a document with Sarvam Vision. Use this for PDFs, scans, document images, handwriting, and table-heavy files; it returns layout-preserving Markdown.",
    promptSnippet:
      "Digitize a PDF, scan, document image, or ZIP of page images with Sarvam Vision.",
    promptGuidelines: [
      "Use document_intelligence before answering questions about PDFs, scans, or document images.",
      "Pass the document's primary language when known; otherwise use en-IN.",
    ],
    parameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, context) {
      const result = await digitizeDocument(params.path, params.language, {
        ...options,
        cwd: context.cwd,
        signal,
        onStatus: (status) => {
          onUpdate?.({
            content: [{ type: "text", text: status }],
            details: { status },
          });
        },
      });
      return {
        content: [{ type: "text", text: result.content }],
        details: result,
      };
    },
  });
}

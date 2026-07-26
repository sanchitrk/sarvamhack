export { createAgent, listAgentSessions } from "./agent.ts";
export {
  DEFAULT_OPENAI_MODEL,
  DEFAULT_SYSTEM_PROMPT,
  readAgentConfig,
  resolveOpenAIModel,
} from "./config.ts";
export {
  AgentBusyError,
  AgentCancelledError,
  AgentConfigError,
  AgentInputError,
} from "./errors.ts";
export {
  createDocumentIntelligenceTool,
  digitizeDocument,
  DOCUMENT_INTELLIGENCE_TOOL_NAME,
} from "./tools/document.ts";
export type { DigitizedDocument, DigitizeDocumentOptions } from "./tools/document.ts";
export { createPdfSplitTool, PDF_SPLIT_TOOL_NAME, splitPdf } from "./tools/pdf.ts";
export type { SplitPdfOptions, SplitPdfResult } from "./tools/pdf.ts";
export type {
  AgentConfig,
  AgentEvent,
  AgentEventListener,
  AgentRuntime,
  AgentSessionOptions,
  AgentSessionSummary,
  ConversationMessage,
} from "./events.ts";

export const CORE_PACKAGE_NAME = "@sarvamhack/core";

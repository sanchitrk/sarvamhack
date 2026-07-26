import { getModels, type Api, type Model } from "@earendil-works/pi-ai/compat";

import { AgentConfigError } from "./errors.ts";
import type { AgentConfig } from "./events.ts";

export const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";

export const DEFAULT_SYSTEM_PROMPT = `You are a helpful conversational voice assistant.
Answer clearly, naturally, and briefly.
Return plain text only.
Do not use Markdown, headings, tables, code fences, or emoji.
Write numbers and abbreviations so they sound natural when spoken.
Ask at most one question at a time.`;

export function resolveOpenAIModel(modelId: string): Model<Api> {
  const model = getModels("openai").find((candidate) => candidate.id === modelId);
  if (!model) {
    throw new AgentConfigError(
      `Unknown OpenAI model "${modelId}" in the installed Pi model catalog`,
    );
  }
  return model;
}

export function readAgentConfig(environment: NodeJS.ProcessEnv = process.env): AgentConfig {
  const provider = environment.PI_PROVIDER?.trim() || "openai";
  if (provider !== "openai") {
    throw new AgentConfigError(
      `Unsupported LLM Provider "${provider}""`,
    );
  }

  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new AgentConfigError("OPENAI_API_KEY is required");
  }

  const model = environment.PI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
  resolveOpenAIModel(model);

  return {
    provider,
    model,
    apiKey,
    sarvamApiKey: environment.SARVAM_API_KEY?.trim() || undefined,
    systemPrompt: environment.AGENT_SYSTEM_PROMPT?.trim() || DEFAULT_SYSTEM_PROMPT,
    cwd: environment.AGENT_CWD?.trim() || process.cwd(),
  };
}

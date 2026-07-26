import { describe, expect, it } from "vitest";

import { DEFAULT_OPENAI_MODEL, readAgentConfig, resolveOpenAIModel } from "../src/config.ts";
import { AgentConfigError } from "../src/errors.ts";

describe("agent configuration", () => {
  it("reads an OpenAI configuration with voice-friendly defaults", () => {
    const config = readAgentConfig({
      OPENAI_API_KEY: "test-key",
      SARVAM_API_KEY: "sarvam-key",
    });

    expect(config.provider).toBe("openai");
    expect(config.model).toBe(DEFAULT_OPENAI_MODEL);
    expect(config.sarvamApiKey).toBe("sarvam-key");
    expect(config.systemPrompt).toContain("plain text only");
  });

  it("accepts a model from the Pi catalog", () => {
    expect(resolveOpenAIModel(DEFAULT_OPENAI_MODEL).id).toBe(DEFAULT_OPENAI_MODEL);
  });

  it("rejects missing credentials", () => {
    expect(() => readAgentConfig({})).toThrow(AgentConfigError);
  });

  it("rejects unsupported providers and models", () => {
    expect(() =>
      readAgentConfig({
        OPENAI_API_KEY: "test-key",
        PI_PROVIDER: "anthropic",
      }),
    ).toThrow(AgentConfigError);
    expect(() => resolveOpenAIModel("not-a-model")).toThrow(AgentConfigError);
  });
});

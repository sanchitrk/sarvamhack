import { describe, expect, it } from "vitest";

import { createSentenceBuffer } from "../src/sentence.ts";

describe("sentence buffer", () => {
  it("emits complete speakable sentences and flushes the tail", () => {
    const buffer = createSentenceBuffer();

    expect(buffer.push("Hello there. How")).toEqual(["Hello there."]);
    expect(buffer.push(" are you? Fine")).toEqual(["How are you?"]);
    expect(buffer.flush()).toBe("Fine");
    expect(buffer.flush()).toBeUndefined();
  });

  it("splits an oversized response without losing text", () => {
    const buffer = createSentenceBuffer();
    const words = Array.from({ length: 100 }, () => "voice").join(" ");
    const chunks = buffer.push(words);
    const tail = buffer.flush();

    expect(chunks.length).toBeGreaterThan(0);
    expect([...chunks, tail].filter(Boolean).join(" ").replaceAll(/\s+/g, " ")).toBe(words);
  });
});

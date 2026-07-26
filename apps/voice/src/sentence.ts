const boundary = /[.!?।॥](?:\s+|$)|\n+/u;
const maxChunkLength = 320;

export interface SentenceBuffer {
  push(text: string): string[];
  flush(): string | undefined;
  clear(): void;
}

export function createSentenceBuffer(): SentenceBuffer {
  let buffer = "";

  return {
    push(text) {
      buffer += text;
      const chunks: string[] = [];

      while (true) {
        const match = boundary.exec(buffer);
        if (!match) break;
        const end = match.index + match[0].length;
        const chunk = buffer.slice(0, end).trim();
        buffer = buffer.slice(end);
        if (chunk) chunks.push(chunk);
      }

      while (buffer.length > maxChunkLength) {
        const splitAt = buffer.lastIndexOf(" ", maxChunkLength);
        const end = splitAt > 0 ? splitAt : maxChunkLength;
        const chunk = buffer.slice(0, end).trim();
        buffer = buffer.slice(end).trimStart();
        if (chunk) chunks.push(chunk);
      }

      return chunks;
    },

    flush() {
      const chunk = buffer.trim();
      buffer = "";
      return chunk || undefined;
    },

    clear() {
      buffer = "";
    },
  };
}

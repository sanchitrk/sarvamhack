import { createInterface } from "node:readline/promises";

import { createAgent } from "./agent.ts";
import { readAgentConfig } from "./config.ts";

const input = createInterface({
  input: process.stdin,
  output: process.stdout,
});
const agent = await createAgent(readAgentConfig());

agent.subscribe((event) => {
  if (event.type === "assistant_start") process.stdout.write("agent: ");
  if (event.type === "assistant_delta") process.stdout.write(event.text);
  if (event.type === "assistant_end") process.stdout.write("\n");
  if (event.type === "tool_start") {
    process.stdout.write(`\n[tool: ${event.name}]\n`);
  }
});

process.on("SIGINT", () => {
  void agent.abort("keyboard interrupt").finally(() => input.close());
});

console.log("Layer 1 ready. Type /reset, /exit, or a message.");

while (true) {
  const text = (await input.question("you: ")).trim();
  if (!text) continue;
  if (text === "/exit") break;
  if (text === "/reset") {
    await agent.reset();
    console.log("Session reset.");
    continue;
  }

  try {
    await agent.prompt(text);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
}

input.close();

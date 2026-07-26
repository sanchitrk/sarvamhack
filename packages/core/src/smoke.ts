import { createAgent } from "./agent.ts";
import { readAgentConfig } from "./config.ts";

const agent = await createAgent(readAgentConfig());
const prompt = process.argv.slice(2).join(" ") || "Reply with exactly: Layer one works.";

agent.subscribe((event) => {
  if (event.type === "assistant_delta") process.stdout.write(event.text);
});

await agent.prompt(prompt);
process.stdout.write("\n");

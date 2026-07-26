import { describe, expect, it, vi } from "vitest";

import {
  createRuntimeWithHarness,
  type AgentHarnessAdapter,
  type HarnessEvent,
} from "../src/agent.ts";
import { AgentBusyError, AgentCancelledError, AgentInputError } from "../src/errors.ts";
import type { AgentEvent } from "../src/events.ts";

class FakeHarness implements AgentHarnessAdapter {
  readonly sessionId = "session-1";
  readonly prompts: string[] = [];
  readonly listeners = new Set<(event: HarnessEvent) => void | Promise<void>>();
  disposed = false;
  response = "Hello there";
  pending = false;
  release: (() => void) | undefined;

  async prompt(text: string): Promise<string> {
    this.prompts.push(text);
    if (this.pending) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    return this.response;
  }

  async abort(): Promise<void> {
    this.release?.();
  }

  history() {
    return [
      { role: "user" as const, text: "hello" },
      { role: "assistant" as const, text: this.response },
    ];
  }

  dispose(): void {
    this.disposed = true;
  }

  subscribe(listener: (event: HarnessEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async emit(event: HarnessEvent): Promise<void> {
    for (const listener of this.listeners) await listener(event);
  }
}

describe("agent runtime", () => {
  it("streams lifecycle events and returns final text", async () => {
    const harness = new FakeHarness();
    harness.pending = true;
    const runtime = await createRuntimeWithHarness(async () => harness);
    const events: AgentEvent[] = [];
    runtime.subscribe((event) => {
      events.push(event);
    });

    const prompt = runtime.prompt("  hello  ");
    await vi.waitFor(() => expect(harness.prompts).toEqual(["hello"]));
    await harness.emit({ type: "assistant_start" });
    await harness.emit({ type: "assistant_delta", text: "Hello " });
    await harness.emit({ type: "assistant_delta", text: "there" });
    await harness.emit({
      type: "tool_start",
      name: "clock",
      args: { zone: "UTC" },
    });
    await harness.emit({
      type: "tool_end",
      name: "clock",
      result: "12:00",
      isError: false,
    });
    harness.release?.();

    await expect(prompt).resolves.toBe("Hello there");
    expect(events.map((event) => event.type)).toEqual([
      "turn_start",
      "assistant_start",
      "assistant_delta",
      "assistant_delta",
      "tool_start",
      "tool_end",
      "assistant_end",
    ]);
    expect(new Set(events.map((event) => event.turnId)).size).toBe(1);
  });

  it("rejects blank and concurrent prompts", async () => {
    const harness = new FakeHarness();
    harness.pending = true;
    const runtime = await createRuntimeWithHarness(async () => harness);

    await expect(runtime.prompt(" ")).rejects.toBeInstanceOf(AgentInputError);
    const first = runtime.prompt("first");
    await vi.waitFor(() => expect(runtime.busy).toBe(true));
    await expect(runtime.prompt("second")).rejects.toBeInstanceOf(AgentBusyError);
    await runtime.abort();
    await expect(first).rejects.toBeInstanceOf(AgentCancelledError);
  });

  it("cancels once and accepts the next turn", async () => {
    const harness = new FakeHarness();
    harness.pending = true;
    const runtime = await createRuntimeWithHarness(async () => harness);
    const events: AgentEvent[] = [];
    runtime.subscribe((event) => {
      events.push(event);
    });

    const first = runtime.prompt("first");
    await vi.waitFor(() => expect(harness.prompts).toEqual(["first"]));
    await runtime.abort("barge-in");
    await runtime.abort("duplicate");

    expect(runtime.busy).toBe(false);
    harness.pending = false;
    await expect(runtime.prompt("second")).resolves.toBe("Hello there");
    await expect(first).rejects.toMatchObject({
      name: "AgentCancelledError",
      reason: "barge-in",
    });
    expect(events.filter((event) => event.type === "turn_cancelled")).toHaveLength(1);
  });

  it("isolates listener failures and rebuilds on reset", async () => {
    const harnesses = [new FakeHarness(), new FakeHarness()];
    let index = 0;
    const runtime = await createRuntimeWithHarness(async () => {
      const harness = harnesses[index];
      index += 1;
      if (!harness) throw new Error("Unexpected harness creation");
      return harness;
    });
    runtime.subscribe(() => {
      throw new Error("listener failed");
    });

    await expect(runtime.prompt("before")).resolves.toBe("Hello there");
    await runtime.reset();
    await expect(runtime.prompt("after")).resolves.toBe("Hello there");
    expect(harnesses[0]?.prompts).toEqual(["before"]);
    expect(harnesses[1]?.prompts).toEqual(["after"]);
  });

  it("emits one normalized error and recovers", async () => {
    const harness = new FakeHarness();
    const runtime = await createRuntimeWithHarness(async () => harness);
    const events: AgentEvent[] = [];
    runtime.subscribe((event) => {
      events.push(event);
    });
    const failure = new Error("provider failed");
    harness.prompt = async () => {
      throw failure;
    };

    await expect(runtime.prompt("hello")).rejects.toBe(failure);
    expect(events.filter((event) => event.type === "turn_error")).toHaveLength(1);
    expect(runtime.busy).toBe(false);
  });

  it("exposes session history and disposes the harness", async () => {
    const harness = new FakeHarness();
    const runtime = await createRuntimeWithHarness(async () => harness);

    expect(runtime.sessionId).toBe("session-1");
    expect(runtime.history()).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "Hello there" },
    ]);

    runtime.dispose();
    expect(harness.disposed).toBe(true);
  });
});

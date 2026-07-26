export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentConfigError";
  }
}

export class AgentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentInputError";
  }
}

export class AgentBusyError extends Error {
  constructor() {
    super("The agent is already processing a turn");
    this.name = "AgentBusyError";
  }
}

export class AgentCancelledError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`The agent turn was cancelled: ${reason}`);
    this.name = "AgentCancelledError";
    this.reason = reason;
  }
}

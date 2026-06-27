import { EventEmitter } from "node:events";
import type {
  AgentMessageInput,
  AgentRuntime,
  AgentSessionInput,
  AgentSessionListInput,
  AgentSessionSettings,
  AgentSteerInput,
} from "../types.js";
import { CodexAppServer } from "./CodexAppServer.js";

type CodexAgentOptions = {
  cwd: string;
  codexBin: string;
};

export class CodexAgent extends EventEmitter implements AgentRuntime {
  readonly id = "codex";
  readonly displayName = "Codex";

  private readonly appServer: CodexAppServer;

  constructor(options: CodexAgentOptions) {
    super();
    this.appServer = new CodexAppServer(options);
    this.forwardEvents();
  }

  start() {
    return this.appServer.start();
  }

  stop() {
    this.appServer.stop();
  }

  startSession(input: AgentSessionSettings) {
    return this.appServer.startThread(input);
  }

  resumeSession(input: AgentSessionInput) {
    return this.appServer.resumeThread({
      threadId: input.sessionId,
      cwd: input.cwd,
      model: input.model,
      approvalPolicy: input.approvalPolicy,
      sandbox: input.sandbox,
      developerInstructions: input.developerInstructions,
    });
  }

  listSessions(input: AgentSessionListInput) {
    return this.appServer.listThreads(input);
  }

  sendMessage(input: AgentMessageInput) {
    return this.appServer.startTurn({
      threadId: input.sessionId,
      text: input.text,
      cwd: input.cwd,
      model: input.model,
      approvalPolicy: input.approvalPolicy,
    });
  }

  steerMessage(input: AgentSteerInput) {
    return this.appServer.steerTurn({
      threadId: input.sessionId,
      turnId: input.turnId,
      text: input.text,
    });
  }

  stopTurn(sessionId: string) {
    return this.appServer.interruptTurn(sessionId);
  }

  private forwardEvents() {
    for (const eventName of ["stderr", "error", "exit", "notification"]) {
      this.appServer.on(eventName, (...args) => this.emit(eventName, ...args));
    }
  }
}

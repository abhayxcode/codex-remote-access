import type { EventEmitter } from "node:events";

export type AgentSessionSettings = {
  cwd?: string;
  model?: string | null;
  approvalPolicy?: string;
  sandbox?: string;
  developerInstructions?: string | null;
};

export type AgentSessionInput = AgentSessionSettings & {
  sessionId?: string;
};

export type AgentMessageInput = {
  sessionId: string;
  text: string;
  cwd?: string;
  model?: string | null;
  approvalPolicy?: string;
};

export type AgentSteerInput = {
  sessionId: string;
  turnId: string;
  text: string;
};

export type AgentSessionListInput = {
  cwd?: string;
  limit?: number;
  cursor?: string | null;
};

export type AgentRuntime = EventEmitter & {
  readonly id: string;
  readonly displayName: string;
  start(): Promise<void>;
  stop(): void;
  startSession(input: AgentSessionSettings): Promise<any>;
  resumeSession(input: AgentSessionInput): Promise<any>;
  listSessions(input: AgentSessionListInput): Promise<any>;
  sendMessage(input: AgentMessageInput): Promise<any>;
  steerMessage(input: AgentSteerInput): Promise<any>;
  stopTurn(sessionId: string): Promise<any>;
};

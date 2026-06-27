import type { AgentRuntime } from "./types.js";

export class AgentRegistry {
  private readonly agents = new Map<string, AgentRuntime>();

  register(agent: AgentRuntime) {
    this.agents.set(agent.id, agent);
  }

  get(id: string) {
    return this.agents.get(id) || null;
  }

  list() {
    return Array.from(this.agents.values());
  }
}

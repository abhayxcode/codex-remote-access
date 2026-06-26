import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
};

type CodexAppServerOptions = {
  cwd: string;
  codexBin?: string;
};

type ThreadOptions = {
  cwd?: string;
  threadId?: string;
  model?: string | null;
  approvalPolicy?: string;
  sandbox?: string;
  developerInstructions?: string | null;
};

export class CodexAppServer extends EventEmitter {
  private cwd: string;
  private codexBin: string;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private proc: ChildProcessWithoutNullStreams | null = null;

  constructor({ cwd, codexBin = "codex" }: CodexAppServerOptions) {
    super();
    this.cwd = cwd;
    this.codexBin = codexBin;
  }

  async start() {
    if (!existsSync(this.cwd)) {
      throw new Error(`CODEX_DEFAULT_CWD does not exist: ${this.cwd}`);
    }

    if (!existsSync(this.codexBin) && this.codexBin.includes("/")) {
      throw new Error(`CODEX_BIN does not exist: ${this.codexBin}`);
    }

    this.proc = spawn(this.codexBin, ["app-server"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.on("error", (error: NodeJS.ErrnoException) => {
      const hint =
        error.code === "ENOENT"
          ? ` Could not find "${this.codexBin}". Set CODEX_BIN to the absolute path from "command -v codex".`
          : "";
      const wrapped = new Error(`failed to start codex app-server.${hint}`);
      wrapped.cause = error;
      for (const { reject } of this.pending.values()) reject(wrapped);
      this.pending.clear();
      this.emit("error", wrapped);
    });

    this.proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      if (text.trim()) this.emit("stderr", text);
    });

    this.proc.on("exit", (code, signal) => {
      const error = new Error(`codex app-server exited with code ${code} signal ${signal}`);
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
      this.emit("exit", { code, signal });
    });

    const lines = createInterface({ input: this.proc.stdout });
    lines.on("line", (line) => this.handleLine(line));

    await this.request("initialize", {
      clientInfo: {
        name: "telegram_codex_remote",
        title: "Telegram Codex Remote",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
  }

  async startThread({ cwd, model, approvalPolicy, sandbox, developerInstructions }: ThreadOptions) {
    const params = clean({
      cwd,
      model,
      approvalPolicy,
      sandbox,
      developerInstructions,
      threadSource: "telegram",
      serviceName: "telegram-codex-remote",
    });
    return this.request("thread/start", params);
  }

  async resumeThread({ threadId, cwd, model, approvalPolicy, sandbox, developerInstructions }: ThreadOptions) {
    return this.request(
      "thread/resume",
      clean({ threadId, cwd, model, approvalPolicy, sandbox, developerInstructions }),
    );
  }

  async listThreads({ cwd, limit = 10, cursor = null }: { cwd?: string; limit?: number; cursor?: string | null } = {}) {
    return this.request("thread/list", clean({ cwd, limit, cursor, archived: false }));
  }

  async startTurn({ threadId, text, cwd, model, approvalPolicy }: {
    threadId: string;
    text: string;
    cwd?: string;
    model?: string | null;
    approvalPolicy?: string;
  }) {
    return this.request(
      "turn/start",
      clean({
        threadId,
        input: [{ type: "text", text, text_elements: [] }],
        cwd,
        model,
        approvalPolicy,
      }),
    );
  }

  async steerTurn({ threadId, turnId, text }: { threadId: string; turnId: string; text: string }) {
    return this.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: "text", text, text_elements: [] }],
    });
  }

  async interruptTurn(threadId: string) {
    return this.request("turn/interrupt", { threadId });
  }

  stop() {
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
    }
  }

  request<T = any>(method: string, params: Record<string, any>): Promise<T> {
    const id = this.nextId++;
    this.write({ method, id, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  notify(method: string, params: Record<string, any> = {}) {
    this.write({ method, params });
  }

  write(message: Record<string, any>) {
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error("codex app-server is not running");
    }
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(line: string) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("stderr", `Invalid JSON from app-server: ${line}`);
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "Codex request failed"));
      else pending.resolve(message.result);
      return;
    }

    if (message.method) this.emit("notification", message);
  }
}

function clean(value: Record<string, any>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== null && item !== undefined && item !== ""),
  );
}

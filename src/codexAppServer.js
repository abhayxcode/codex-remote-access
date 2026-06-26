import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";

export class CodexAppServer extends EventEmitter {
  constructor({ cwd, codexBin = "codex" }) {
    super();
    this.cwd = cwd;
    this.codexBin = codexBin;
    this.nextId = 1;
    this.pending = new Map();
    this.proc = null;
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

    this.proc.on("error", (error) => {
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

  async startThread({ cwd, model, approvalPolicy, sandbox }) {
    const params = clean({
      cwd,
      model,
      approvalPolicy,
      sandbox,
      threadSource: "telegram",
      serviceName: "telegram-codex-remote",
    });
    return this.request("thread/start", params);
  }

  async resumeThread({ threadId, cwd, model, approvalPolicy, sandbox }) {
    return this.request(
      "thread/resume",
      clean({ threadId, cwd, model, approvalPolicy, sandbox }),
    );
  }

  async listThreads({ cwd, limit = 10 } = {}) {
    return this.request("thread/list", clean({ cwd, limit, archived: false }));
  }

  async startTurn({ threadId, text, cwd, model, approvalPolicy }) {
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

  async steerTurn({ threadId, turnId, text }) {
    return this.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: "text", text, text_elements: [] }],
    });
  }

  async interruptTurn(threadId) {
    return this.request("turn/interrupt", { threadId });
  }

  stop() {
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
    }
  }

  request(method, params) {
    const id = this.nextId++;
    this.write({ method, id, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  notify(method, params = {}) {
    this.write({ method, params });
  }

  write(message) {
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error("codex app-server is not running");
    }
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(line) {
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

function clean(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== null && item !== undefined && item !== ""),
  );
}

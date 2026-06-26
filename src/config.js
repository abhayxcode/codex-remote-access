import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

export function loadDotEnv(path = ".env") {
  if (!existsSync(path)) return;
  const body = readFileSync(path, "utf8");
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key) process.env[key] = value;
  }
}

export function getConfig() {
  loadDotEnv();

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required. Copy .env.example to .env and fill it in.");
  }

  const allowedUsers = new Set(
    (process.env.TELEGRAM_ALLOWED_USER_IDS || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );

  if (allowedUsers.size === 0) {
    throw new Error("TELEGRAM_ALLOWED_USER_IDS is required. Use your numeric Telegram user ID.");
  }

  const parentDir = realpathSync(resolve(process.env.CODEX_PARENT_DIR || process.env.CODEX_DEFAULT_CWD || process.cwd()));
  const defaultCwd = realpathSync(resolve(process.env.CODEX_DEFAULT_CWD || process.cwd()));

  const approvalPolicy = emptyToNull(process.env.CODEX_APPROVAL_POLICY) || "on-request";
  const sandbox = emptyToNull(process.env.CODEX_SANDBOX) || "workspace-write";
  validateChoice("CODEX_APPROVAL_POLICY", approvalPolicy, ["untrusted", "on-request", "never", "on-failure"]);
  validateChoice("CODEX_SANDBOX", sandbox, ["read-only", "workspace-write", "danger-full-access"]);

  return {
    telegramToken: token,
    allowedUsers,
    codexBin: emptyToNull(process.env.CODEX_BIN) || "codex",
    defaultCwd,
    parentDir,
    model: emptyToNull(process.env.CODEX_MODEL),
    approvalPolicy,
    sandbox,
    dataDir: resolve(process.env.DATA_DIR || "data"),
  };
}

function emptyToNull(value) {
  return value && value.trim() ? value.trim() : null;
}

function validateChoice(name, value, allowed) {
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  }
}

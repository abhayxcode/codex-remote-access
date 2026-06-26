import { getConfig } from "./config.js";
import { CodexAppServer } from "./codexAppServer.js";
import { StateStore } from "./state.js";
import { TelegramClient, getMessageText } from "./telegram.js";
import { existsSync } from "node:fs";

const config = getConfig();
const telegram = new TelegramClient(config.telegramToken);
const state = new StateStore(config.dataDir);
const codex = new CodexAppServer({ cwd: config.defaultCwd, codexBin: config.codexBin });

const activeChatsByThread = new Map();
const buffersByTurn = new Map();

codex.on("stderr", (text) => process.stderr.write(text));
codex.on("error", (error) => {
  console.error(error.message);
  if (error.cause) console.error(error.cause.message);
  process.exit(1);
});
codex.on("exit", ({ code, signal }) => {
  console.error(`codex app-server exited: code=${code} signal=${signal}`);
  process.exitCode = 1;
});
codex.on("notification", (message) => {
  void handleCodexNotification(message).catch((error) => {
    console.error("notification handling failed:", error);
  });
});

await codex.start();
console.log("Telegram Codex remote is running.");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    codex.stop();
    process.exit(0);
  });
}

while (true) {
  try {
    const updates = await telegram.poll();
    for (const update of updates) {
      await handleUpdate(update);
    }
  } catch (error) {
    console.error(error);
    await sleep(2000);
  }
}

async function handleUpdate(update) {
  const message = update.message;
  const text = getMessageText(update);
  if (!message || !text) return;

  const chatId = message.chat.id;
  const userId = String(message.from?.id || "");
  if (!config.allowedUsers.has(userId)) {
    await telegram.sendMessage(chatId, "This bot is not authorized for your Telegram user.");
    return;
  }

  if (text.startsWith("/")) {
    await handleCommand(chatId, text);
    return;
  }

  await sendToCodex(chatId, text);
}

async function handleCommand(chatId, text) {
  const [command, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(" ").trim();

  switch (command.split("@")[0]) {
    case "/start":
    case "/help":
      await telegram.sendMessage(chatId, helpText());
      return;
    case "/new":
      await newThread(chatId, arg || state.getChat(chatId).cwd || config.defaultCwd);
      return;
    case "/resume":
      await resumeThread(chatId, arg);
      return;
    case "/sessions":
      await listSessions(chatId);
      return;
    case "/settings":
      await showSettings(chatId);
      return;
    case "/model":
      await setModel(chatId, arg);
      return;
    case "/approval":
      await setApproval(chatId, arg);
      return;
    case "/sandbox":
      await setSandbox(chatId, arg);
      return;
    case "/cwd":
      await setCwd(chatId, arg);
      return;
    case "/status":
      await showStatus(chatId);
      return;
    case "/stop":
      await stopTurn(chatId);
      return;
    default:
      await telegram.sendMessage(chatId, "Unknown command. Send /help.");
  }
}

async function newThread(chatId, cwd) {
  await telegram.sendChatAction(chatId);
  const settings = getChatSettings(chatId);
  const result = await codex.startThread({
    cwd,
    model: settings.model,
    approvalPolicy: settings.approvalPolicy,
    sandbox: settings.sandbox,
  });
  const threadId = result.thread.id;
  state.updateChat(chatId, { threadId, cwd: result.cwd || cwd, activeTurnId: null });
  activeChatsByThread.set(threadId, String(chatId));
  await telegram.sendMessage(
    chatId,
    `Started Codex thread:\n${threadId}\n\nResume from CLI:\ncodex resume ${threadId}`,
  );
}

async function resumeThread(chatId, threadId) {
  if (!threadId) {
    await telegram.sendMessage(chatId, "Usage: /resume <codex-thread-id>");
    return;
  }

  await telegram.sendChatAction(chatId);
  const settings = getChatSettings(chatId);
  const result = await codex.resumeThread({
    threadId,
    model: settings.model,
    approvalPolicy: settings.approvalPolicy,
    sandbox: settings.sandbox,
  });

  state.updateChat(chatId, {
    threadId: result.thread.id,
    cwd: result.cwd || null,
    activeTurnId: null,
  });
  activeChatsByThread.set(result.thread.id, String(chatId));
  await telegram.sendMessage(chatId, `Resumed Codex thread:\n${result.thread.id}`);
}

async function listSessions(chatId) {
  await telegram.sendChatAction(chatId);
  const result = await codex.listThreads({ cwd: null, limit: 10 });
  if (!result.data?.length) {
    await telegram.sendMessage(chatId, "No Codex sessions found.");
    return;
  }
  const rows = result.data.map((thread, index) => {
    const title = thread.title || thread.name || "(untitled)";
    const cwd = thread.cwd || thread.metadata?.cwd || "";
    return `${index + 1}. ${title}\n${thread.id}${cwd ? `\n${cwd}` : ""}`;
  });
  await telegram.sendMessage(chatId, `Recent Codex sessions:\n\n${rows.join("\n\n")}`);
}

async function showStatus(chatId) {
  const chat = state.getChat(chatId);
  const settings = getChatSettings(chatId);
  await telegram.sendMessage(
    chatId,
    [
      `Thread: ${chat.threadId || "(none)"}`,
      `CWD: ${chat.cwd || config.defaultCwd}`,
      `Model: ${settings.model || "(default)"}`,
      `Approval: ${settings.approvalPolicy}`,
      `Sandbox: ${settings.sandbox}`,
      `Active turn: ${chat.activeTurnId || "(none)"}`,
      chat.threadId ? `CLI resume: codex resume ${chat.threadId}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

async function stopTurn(chatId) {
  const chat = state.getChat(chatId);
  if (!chat.threadId || !chat.activeTurnId) {
    await telegram.sendMessage(chatId, "No active Codex turn to stop.");
    return;
  }
  await codex.interruptTurn(chat.threadId);
  state.updateChat(chatId, { activeTurnId: null });
  await telegram.sendMessage(chatId, "Stop requested.");
}

async function sendToCodex(chatId, text) {
  let chat = state.getChat(chatId);
  if (!chat.threadId) {
    await newThread(chatId, config.defaultCwd);
    chat = state.getChat(chatId);
  }

  activeChatsByThread.set(chat.threadId, String(chatId));
  await telegram.sendChatAction(chatId);

  if (chat.activeTurnId) {
    await codex.steerTurn({ threadId: chat.threadId, turnId: chat.activeTurnId, text });
    await telegram.sendMessage(chatId, "Added to the active Codex turn.");
    return;
  }

  const result = await codex.startTurn({
    threadId: chat.threadId,
    text,
    cwd: chat.cwd || config.defaultCwd,
    model: getChatSettings(chatId).model,
    approvalPolicy: getChatSettings(chatId).approvalPolicy,
  });
  const turnId = result.turn.id;
  state.updateChat(chatId, { activeTurnId: turnId });
  await telegram.sendMessage(chatId, `Codex started turn ${turnId}.`);
}

async function showSettings(chatId) {
  const chat = state.getChat(chatId);
  const settings = getChatSettings(chatId);
  await telegram.sendMessage(
    chatId,
    [
      `Model: ${settings.model || "(default)"}`,
      `Approval: ${settings.approvalPolicy}`,
      `Sandbox: ${settings.sandbox}`,
      `CWD: ${chat.cwd || config.defaultCwd}`,
      "",
      "Commands:",
      "/model default",
      "/model gpt-5.5",
      "/approval on-request",
      "/approval never",
      "/approval untrusted",
      "/sandbox read-only",
      "/sandbox workspace-write",
      "/sandbox danger-full-access",
      "/cwd /absolute/path/to/repo",
    ].join("\n"),
  );
}

async function setModel(chatId, value) {
  const model = normalizeDefault(value);
  state.updateChat(chatId, { settings: { ...state.getChat(chatId).settings, model } });
  await telegram.sendMessage(chatId, `Model set to: ${model || "(default)"}`);
}

async function setApproval(chatId, value) {
  const allowed = new Set(["untrusted", "on-request", "never", "on-failure"]);
  if (!allowed.has(value)) {
    await telegram.sendMessage(chatId, "Usage: /approval untrusted|on-request|never|on-failure");
    return;
  }
  state.updateChat(chatId, { settings: { ...state.getChat(chatId).settings, approvalPolicy: value } });
  await telegram.sendMessage(chatId, `Approval policy set to: ${value}`);
}

async function setSandbox(chatId, value) {
  const allowed = new Set(["read-only", "workspace-write", "danger-full-access"]);
  if (!allowed.has(value)) {
    await telegram.sendMessage(chatId, "Usage: /sandbox read-only|workspace-write|danger-full-access");
    return;
  }
  state.updateChat(chatId, { settings: { ...state.getChat(chatId).settings, sandbox: value } });
  await telegram.sendMessage(chatId, `Sandbox set to: ${value}`);
}

async function setCwd(chatId, value) {
  if (!value || !value.startsWith("/")) {
    await telegram.sendMessage(chatId, "Usage: /cwd /absolute/path/to/repo");
    return;
  }
  if (!existsSync(value)) {
    await telegram.sendMessage(chatId, `Path does not exist:\n${value}`);
    return;
  }
  state.updateChat(chatId, { cwd: value });
  await telegram.sendMessage(chatId, `CWD set to:\n${value}`);
}

async function handleCodexNotification(message) {
  const params = message.params || {};
  const threadId = params.threadId;
  const chatId = threadId ? activeChatsByThread.get(threadId) : null;
  if (!chatId) return;

  if (message.method === "turn/started") {
    state.updateChat(chatId, { activeTurnId: params.turn?.id || null });
    return;
  }

  if (message.method === "item/agentMessage/delta") {
    const key = `${params.threadId}:${params.turnId}:${params.itemId}`;
    const next = `${buffersByTurn.get(key) || ""}${params.delta || ""}`;
    buffersByTurn.set(key, next);
    if (next.length > 1200 || /[\n.!?]\s$/.test(next)) {
      buffersByTurn.set(key, "");
      await telegram.sendMessage(chatId, next);
    }
    return;
  }

  if (message.method === "item/started") {
    const item = params.item || {};
    const label = itemLabel(item);
    if (label) await telegram.sendMessage(chatId, label);
    return;
  }

  if (message.method === "turn/completed") {
    flushTurnBuffers(params.threadId, params.turn?.id, chatId);
    state.updateChat(chatId, { activeTurnId: null });
    const status = params.turn?.status || "completed";
    await telegram.sendMessage(chatId, `Codex turn ${status}.`);
    return;
  }

  if (message.method === "error" || message.method === "warning") {
    await telegram.sendMessage(chatId, `${message.method}: ${params.message || JSON.stringify(params)}`);
  }
}

function flushTurnBuffers(threadId, turnId, chatId) {
  for (const [key, value] of buffersByTurn.entries()) {
    if (!key.startsWith(`${threadId}:${turnId}:`)) continue;
    buffersByTurn.delete(key);
    if (value.trim()) void telegram.sendMessage(chatId, value);
  }
}

function itemLabel(item) {
  if (!item || !item.type) return null;
  if (item.type === "commandExecution") return `Running command: ${item.command || "(command)"}`;
  if (item.type === "fileChange") return `Editing file: ${item.path || "(file)"}`;
  if (item.type === "mcpToolCall") return `Calling tool: ${item.name || "(tool)"}`;
  return null;
}

function helpText() {
  return [
    "Codex remote access commands:",
    "/new [cwd] - start a new persistent Codex thread",
    "/resume <thread-id> - attach this chat to an existing Codex thread",
    "/sessions - list recent local Codex sessions",
    "/settings - show Codex defaults for this Telegram chat",
    "/model <model|default> - set model for future turns",
    "/approval <policy> - set approval policy",
    "/sandbox <mode> - set sandbox mode for future threads",
    "/cwd <path> - set working directory",
    "/status - show current mapping and CLI resume command",
    "/stop - interrupt the active Codex turn",
    "",
    "Any normal message is sent to the current Codex thread.",
  ].join("\n");
}

function getChatSettings(chatId) {
  const settings = state.getChat(chatId).settings || {};
  return {
    model: settings.model ?? config.model,
    approvalPolicy: settings.approvalPolicy || config.approvalPolicy,
    sandbox: settings.sandbox || config.sandbox,
  };
}

function normalizeDefault(value) {
  if (!value || value === "default" || value === "none" || value === "unset") return null;
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

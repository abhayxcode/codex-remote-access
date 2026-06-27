import { CodexAgent } from "../agents/codex/CodexAgent.js";
import { getConfig } from "../config/config.js";
import { commandForButton } from "../core/commands.js";
import { RateLimiter } from "../security/RateLimiter.js";
import { StateStore } from "../state/StateStore.js";
import { TelegramClient, getMessageText } from "../transports/telegram/TelegramClient.js";
import type { TelegramCallbackQuery, TelegramChatId, TelegramUpdate } from "../transports/telegram/TelegramClient.js";
import { helpText, mainKeyboard } from "../transports/telegram/telegramUi.js";
import { WorkdirBrowser } from "../workspace/WorkdirBrowser.js";
import type { WorkdirToken } from "../workspace/WorkdirBrowser.js";
import { WorkspaceScope } from "../workspace/WorkspaceScope.js";
import { sleep } from "../utils/async.js";

type CodexNotification = {
  method?: string;
  params?: Record<string, any>;
};

const config = getConfig();
const telegram = new TelegramClient(config.telegramToken);
const state = new StateStore(config.dataDir);
const codex = new CodexAgent({ cwd: config.defaultCwd, codexBin: config.codexBin });
const workspace = new WorkspaceScope(config.parentDir, config.defaultCwd);
const workdirBrowser = new WorkdirBrowser(workspace);
const rateLimiter = new RateLimiter(config.rateLimitWindowSeconds, config.rateLimitMaxUpdates);

const activeChatsByThread = new Map<string, string>();
const buffersByTurn = new Map<string, string>();
const workdirTokens = new Map<string, WorkdirToken>();

export async function startTelegramCodexApp() {
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
}

export function stopTelegramCodexApp() {
  codex.stop();
}

async function handleUpdate(update: TelegramUpdate) {
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }

  const message = update.message;
  const text = getMessageText(update);
  if (!message || !text) return;

  const chatId = message.chat.id;
  const userId = String(message.from?.id || "");
  if (!config.allowedUsers.has(userId)) {
    await telegram.sendMessage(chatId, "This bot is not authorized for your Telegram user.");
    return;
  }
  if (!(await checkRateLimit({ userId, chatId }))) return;

  if (text.startsWith("/")) {
    try {
      await handleCommand(chatId, text);
    } catch (error) {
      await telegram.sendMessage(chatId, error.message);
    }
    return;
  }

  const buttonCommand = commandForButton(text);
  if (buttonCommand) {
    try {
      await handleCommand(chatId, buttonCommand);
    } catch (error) {
      await telegram.sendMessage(chatId, error.message, mainKeyboard());
    }
    return;
  }

  try {
    await sendToCodex(chatId, text);
  } catch (error) {
    await telegram.sendMessage(chatId, error.message);
  }
}

async function handleCommand(chatId: TelegramChatId, text: string) {
  const [command, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(" ").trim();

  switch (command.split("@")[0]) {
    case "/start":
    case "/help":
      await telegram.sendMessage(chatId, helpText(), mainKeyboard());
      return;
    case "/new":
      await newThread(chatId, arg || selectedWorkspaceCwd(chatId));
      return;
    case "/resume":
      await resumeThread(chatId, arg);
      return;
    case "/sessions":
      await listSessions(chatId);
      return;
    case "/workdir":
      await showWorkdirPicker(chatId, state.getChat(chatId).cwd || config.defaultCwd);
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

async function newThread(chatId: TelegramChatId, cwd: string) {
  const safeCwd = workspace.requireWorkspaceDirectory(cwd);
  await telegram.sendChatAction(chatId);
  const settings = getChatSettings(chatId);
  const result = await codex.startSession({
    cwd: safeCwd,
    model: settings.model,
    approvalPolicy: settings.approvalPolicy,
    sandbox: settings.sandbox,
    developerInstructions: telegramDeveloperInstructions(),
  });
  const threadId = result.thread.id;
  state.updateChat(chatId, { threadId, cwd: result.cwd || safeCwd, activeTurnId: null });
  activeChatsByThread.set(threadId, String(chatId));
  await telegram.sendMessage(
    chatId,
    `Started Codex thread:\n${threadId}\n\nResume from CLI:\ncodex resume ${threadId}`,
    mainKeyboard(),
  );
}

async function resumeThread(chatId: TelegramChatId, threadId: string) {
  if (!threadId) {
    await telegram.sendMessage(chatId, "Usage: /resume <codex-thread-id>");
    return;
  }

  await telegram.sendChatAction(chatId);
  const allowedThread = await findThreadInSelectedCwd(chatId, threadId);
  if (!allowedThread) {
    await telegram.sendMessage(
      chatId,
      [
        "Refusing to resume that thread because it is not in the current working directory.",
        "",
        `Current working directory: ${workspace.displayPath(state.getChat(chatId).cwd || config.defaultCwd)}`,
        "",
        "Use /workdir to choose the thread's directory, then /sessions to list allowed sessions.",
      ].join("\n"),
    );
    return;
  }

  const settings = getChatSettings(chatId);
  const result = await codex.resumeSession({
    sessionId: threadId,
    model: settings.model,
    approvalPolicy: settings.approvalPolicy,
    sandbox: settings.sandbox,
    developerInstructions: telegramDeveloperInstructions(),
  });

  if (result.cwd && !workspace.isAllowedPath(result.cwd)) {
    await telegram.sendMessage(
      chatId,
      "Refusing to attach to a session outside the allowed parent.",
    );
    return;
  }

  state.updateChat(chatId, {
    threadId: result.thread.id,
    cwd: result.cwd || null,
    activeTurnId: null,
  });
  activeChatsByThread.set(result.thread.id, String(chatId));
  await telegram.sendMessage(chatId, `Resumed Codex thread:\n${result.thread.id}`, mainKeyboard());
}

async function listSessions(chatId: TelegramChatId) {
  await telegram.sendChatAction(chatId);
  const cwd = workspace.requireWorkspaceDirectory(selectedWorkspaceCwd(chatId));
  const result = await codex.listSessions({ cwd, limit: 10 });
  if (!result.data?.length) {
    await telegram.sendMessage(chatId, `No Codex sessions found in:\n${workspace.displayPath(cwd)}`, mainKeyboard());
    return;
  }
  const rows = result.data.map((thread, index) => {
    const title = thread.title || thread.name || "(untitled)";
    const cwd = thread.cwd || thread.metadata?.cwd || "";
    return `${index + 1}. ${title}\n${thread.id}${cwd ? `\n${workspace.displayPath(cwd)}` : ""}`;
  });
  await telegram.sendMessage(chatId, `Recent Codex sessions in:\n${workspace.displayPath(cwd)}\n\n${rows.join("\n\n")}`, mainKeyboard());
}

async function showStatus(chatId: TelegramChatId) {
  const chat = state.getChat(chatId);
  const settings = getChatSettings(chatId);
  await telegram.sendMessage(
    chatId,
    [
      `Thread: ${chat.threadId || "(none)"}`,
      `CWD: ${workspace.displayPath(selectedWorkspaceCwd(chatId))}`,
      `Parent: /`,
      `Model: ${settings.model || "(default)"}`,
      `Approval: ${settings.approvalPolicy}`,
      `Sandbox: ${settings.sandbox}`,
      `TG Caveman: ${config.telegramCavemanMode}`,
      `Active turn: ${chat.activeTurnId || "(none)"}`,
      chat.threadId ? `CLI resume: codex resume ${chat.threadId}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
    mainKeyboard(),
  );
}

async function stopTurn(chatId: TelegramChatId) {
  const chat = state.getChat(chatId);
  if (!chat.threadId || !chat.activeTurnId) {
    await telegram.sendMessage(chatId, "No active Codex turn to stop.", mainKeyboard());
    return;
  }
  await codex.stopTurn(chat.threadId);
  state.updateChat(chatId, { activeTurnId: null });
  await telegram.sendMessage(chatId, "Stop requested.", mainKeyboard());
}

async function sendToCodex(chatId: TelegramChatId, text: string) {
  let chat = state.getChat(chatId);
  if (!chat.threadId) {
    await newThread(chatId, selectedWorkspaceCwd(chatId));
    chat = state.getChat(chatId);
  }

  if (!chat.threadId) throw new Error("Failed to create Codex thread.");
  activeChatsByThread.set(chat.threadId, String(chatId));
  await telegram.sendChatAction(chatId);

  if (chat.activeTurnId) {
    await codex.steerMessage({ sessionId: chat.threadId, turnId: chat.activeTurnId, text });
    return;
  }

  const result = await codex.sendMessage({
    sessionId: chat.threadId,
    text,
    cwd: selectedWorkspaceCwd(chatId),
    model: getChatSettings(chatId).model,
    approvalPolicy: getChatSettings(chatId).approvalPolicy,
  });
  const turnId = result.turn.id;
  state.updateChat(chatId, { activeTurnId: turnId });
}

async function showSettings(chatId: TelegramChatId) {
  const chat = state.getChat(chatId);
  const settings = getChatSettings(chatId);
  await telegram.sendMessage(
    chatId,
    [
      `Model: ${settings.model || "(default)"}`,
      `Approval: ${settings.approvalPolicy}`,
      `Sandbox: ${settings.sandbox}`,
      `TG Caveman: ${config.telegramCavemanMode}`,
      `CWD: ${workspace.displayPath(selectedWorkspaceCwd(chatId))}`,
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
      "/workdir",
    ].join("\n"),
    mainKeyboard(),
  );
}

async function setModel(chatId: TelegramChatId, value: string) {
  const model = normalizeDefault(value);
  state.updateChat(chatId, { settings: { ...state.getChat(chatId).settings, model } });
  await telegram.sendMessage(chatId, `Model set to: ${model || "(default)"}`, mainKeyboard());
}

async function setApproval(chatId: TelegramChatId, value: string) {
  const allowed = new Set(["untrusted", "on-request", "never", "on-failure"]);
  if (!allowed.has(value)) {
    await telegram.sendMessage(chatId, "Usage: /approval untrusted|on-request|never|on-failure", mainKeyboard());
    return;
  }
  state.updateChat(chatId, { settings: { ...state.getChat(chatId).settings, approvalPolicy: value } });
  await telegram.sendMessage(chatId, `Approval policy set to: ${value}`, mainKeyboard());
}

async function setSandbox(chatId: TelegramChatId, value: string) {
  const allowed = new Set(["read-only", "workspace-write", "danger-full-access"]);
  if (!allowed.has(value)) {
    await telegram.sendMessage(chatId, "Usage: /sandbox read-only|workspace-write|danger-full-access", mainKeyboard());
    return;
  }
  state.updateChat(chatId, { settings: { ...state.getChat(chatId).settings, sandbox: value } });
  await telegram.sendMessage(chatId, `Sandbox set to: ${value}`, mainKeyboard());
}

async function setCwd(chatId: TelegramChatId, value: string) {
  if (!value || !value.startsWith("/")) {
    await telegram.sendMessage(chatId, "Use /workdir to choose a directory.", mainKeyboard());
    return;
  }
  const cwd = workspace.validateDirectory(value);
  if (!cwd.ok) {
    await telegram.sendMessage(chatId, cwd.message, mainKeyboard());
    return;
  }
  if (cwd.path === config.parentDir) {
    await telegram.sendMessage(chatId, "Choose a project directory inside /, not / itself.", mainKeyboard());
    return;
  }
  state.updateChat(chatId, { cwd: cwd.path });
  await telegram.sendMessage(chatId, `CWD set to:\n${workspace.displayPath(cwd.path)}`, mainKeyboard());
}

async function handleCallbackQuery(query: TelegramCallbackQuery) {
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  if (!chatId || !messageId) return;

  const userId = String(query.from?.id || "");
  if (!config.allowedUsers.has(userId)) {
    await telegram.answerCallbackQuery(query.id, "Not authorized");
    return;
  }
  if (!(await checkRateLimit({ userId, callbackQueryId: query.id }))) return;

  const [kind, token] = String(query.data || "").split("|");
  if (kind !== "wd") {
    await telegram.answerCallbackQuery(query.id);
    return;
  }

  const target = workdirTokens.get(token);
  if (!target) {
    await telegram.answerCallbackQuery(query.id, "That directory picker expired. Send /workdir again.");
    return;
  }

  const validation = workspace.validateDirectory(target.path);
  if (!validation.ok) {
    await telegram.answerCallbackQuery(query.id, validation.message);
    return;
  }

  if (target.action === "page") {
    await telegram.answerCallbackQuery(query.id);
    await renderWorkdirPicker(chatId, messageId, validation.path, target.page || 0);
    return;
  }

  if (validation.path === config.parentDir) {
    await telegram.answerCallbackQuery(query.id, "Browse into a project folder");
  } else {
    state.updateChat(chatId, { cwd: validation.path });
    await telegram.answerCallbackQuery(query.id, "Working directory selected");
  }
  await renderWorkdirPicker(chatId, messageId, validation.path, 0);
}

async function showWorkdirPicker(chatId: TelegramChatId, cwd: string) {
  const validation = workspace.validateDirectory(cwd);
  if (!validation.ok) {
    await telegram.sendMessage(chatId, validation.message, mainKeyboard());
    return;
  }
  const view = buildWorkdirPickerView(validation.path, 0);
  await telegram.sendMessage(chatId, view.text, {
    ...mainKeyboard(),
    reply_markup: view.replyMarkup,
  });
}

async function renderWorkdirPicker(chatId: TelegramChatId, messageId: number, cwd: string, page = 0) {
  const view = buildWorkdirPickerView(cwd, page);
  await telegram.editMessageText(chatId, messageId, view.text, { reply_markup: view.replyMarkup });
}

async function handleCodexNotification(message: CodexNotification) {
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

  if (message.method === "turn/completed") {
    flushTurnBuffers(params.threadId, params.turn?.id, chatId);
    state.updateChat(chatId, { activeTurnId: null });
    return;
  }

  if (message.method === "error") {
    await telegram.sendMessage(chatId, `${message.method}: ${workspace.redactPaths(params.message || JSON.stringify(params))}`);
  }
}

function flushTurnBuffers(threadId: string, turnId: string, chatId: TelegramChatId) {
  for (const [key, value] of buffersByTurn.entries()) {
    if (!key.startsWith(`${threadId}:${turnId}:`)) continue;
    buffersByTurn.delete(key);
    if (value.trim()) void telegram.sendMessage(chatId, value);
  }
}

async function checkRateLimit({
  userId,
  chatId = null,
  callbackQueryId = null,
}: {
  userId: string;
  chatId?: TelegramChatId | null;
  callbackQueryId?: string | null;
}) {
  const result = rateLimiter.check(userId);
  if (result.ok) return true;

  const message = `Rate limit hit. Try again in ${result.retrySeconds}s.`;
  if (callbackQueryId) {
    await telegram.answerCallbackQuery(callbackQueryId, message);
  } else if (chatId) {
    await telegram.sendMessage(chatId, message, mainKeyboard());
  }
  return false;
}

function buildWorkdirPickerView(cwd: string, page = 0) {
  return workdirBrowser.buildPicker(cwd, page, workdirCallback);
}

function workdirCallback(path: string, metadata: Omit<WorkdirToken, "path"> = {}) {
  const token = Math.random().toString(36).slice(2, 10);
  workdirTokens.set(token, { path, ...metadata });
  return `wd|${token}`;
}

function selectedWorkspaceCwd(chatId: TelegramChatId) {
  const cwd = state.getChat(chatId).cwd;
  return workspace.selectedWorkspaceCwd(cwd);
}

async function findThreadInSelectedCwd(chatId: TelegramChatId, threadId: string) {
  const cwd = workspace.requireWorkspaceDirectory(selectedWorkspaceCwd(chatId));
  let cursor = null;
  for (let page = 0; page < 5; page += 1) {
    const result = await codex.listSessions({ cwd, limit: 50, cursor });
    const match = result.data?.find((thread) => thread.id === threadId);
    if (match) return match;
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return null;
}

function getChatSettings(chatId: TelegramChatId) {
  const settings = state.getChat(chatId).settings || {};
  return {
    model: settings.model ?? config.model,
    approvalPolicy: settings.approvalPolicy || config.approvalPolicy,
    sandbox: settings.sandbox || config.sandbox,
  };
}

function normalizeDefault(value: string) {
  if (!value || value === "default" || value === "none" || value === "unset") return null;
  return value;
}

function telegramDeveloperInstructions() {
  if (config.telegramCavemanMode === "off") return null;
  return `Use caveman ${config.telegramCavemanMode} mode.`;
}

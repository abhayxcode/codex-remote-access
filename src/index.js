import { getConfig } from "./config.js";
import { CodexAppServer } from "./codexAppServer.js";
import { StateStore } from "./state.js";
import { TelegramClient, getMessageText } from "./telegram.js";
import { existsSync, realpathSync, readdirSync, statSync } from "node:fs";
import { basename, relative, resolve } from "node:path";

const config = getConfig();
const telegram = new TelegramClient(config.telegramToken);
const state = new StateStore(config.dataDir);
const codex = new CodexAppServer({ cwd: config.defaultCwd, codexBin: config.codexBin });

const activeChatsByThread = new Map();
const buffersByTurn = new Map();
const workdirTokens = new Map();
const rateLimitBuckets = new Map();
const WORKDIR_PAGE_SIZE = 20;

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

async function handleCommand(chatId, text) {
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

async function newThread(chatId, cwd) {
  const safeCwd = requireWorkspaceDirectory(cwd);
  await telegram.sendChatAction(chatId);
  const settings = getChatSettings(chatId);
  const result = await codex.startThread({
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

async function resumeThread(chatId, threadId) {
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
        `Current working directory: ${displayPath(state.getChat(chatId).cwd || config.defaultCwd)}`,
        "",
        "Use /workdir to choose the thread's directory, then /sessions to list allowed sessions.",
      ].join("\n"),
    );
    return;
  }

  const settings = getChatSettings(chatId);
  const result = await codex.resumeThread({
    threadId,
    model: settings.model,
    approvalPolicy: settings.approvalPolicy,
    sandbox: settings.sandbox,
    developerInstructions: telegramDeveloperInstructions(),
  });

  if (result.cwd && !isAllowedPath(result.cwd)) {
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

async function listSessions(chatId) {
  await telegram.sendChatAction(chatId);
  const cwd = requireWorkspaceDirectory(selectedWorkspaceCwd(chatId));
  const result = await codex.listThreads({ cwd, limit: 10 });
  if (!result.data?.length) {
    await telegram.sendMessage(chatId, `No Codex sessions found in:\n${displayPath(cwd)}`, mainKeyboard());
    return;
  }
  const rows = result.data.map((thread, index) => {
    const title = thread.title || thread.name || "(untitled)";
    const cwd = thread.cwd || thread.metadata?.cwd || "";
    return `${index + 1}. ${title}\n${thread.id}${cwd ? `\n${displayPath(cwd)}` : ""}`;
  });
  await telegram.sendMessage(chatId, `Recent Codex sessions in:\n${displayPath(cwd)}\n\n${rows.join("\n\n")}`, mainKeyboard());
}

async function showStatus(chatId) {
  const chat = state.getChat(chatId);
  const settings = getChatSettings(chatId);
  await telegram.sendMessage(
    chatId,
    [
      `Thread: ${chat.threadId || "(none)"}`,
      `CWD: ${displayPath(selectedWorkspaceCwd(chatId))}`,
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

async function stopTurn(chatId) {
  const chat = state.getChat(chatId);
  if (!chat.threadId || !chat.activeTurnId) {
    await telegram.sendMessage(chatId, "No active Codex turn to stop.", mainKeyboard());
    return;
  }
  await codex.interruptTurn(chat.threadId);
  state.updateChat(chatId, { activeTurnId: null });
  await telegram.sendMessage(chatId, "Stop requested.", mainKeyboard());
}

async function sendToCodex(chatId, text) {
  let chat = state.getChat(chatId);
  if (!chat.threadId) {
    await newThread(chatId, selectedWorkspaceCwd(chatId));
    chat = state.getChat(chatId);
  }

  activeChatsByThread.set(chat.threadId, String(chatId));
  await telegram.sendChatAction(chatId);

  if (chat.activeTurnId) {
    await codex.steerTurn({ threadId: chat.threadId, turnId: chat.activeTurnId, text });
    return;
  }

  const result = await codex.startTurn({
    threadId: chat.threadId,
    text,
    cwd: selectedWorkspaceCwd(chatId),
    model: getChatSettings(chatId).model,
    approvalPolicy: getChatSettings(chatId).approvalPolicy,
  });
  const turnId = result.turn.id;
  state.updateChat(chatId, { activeTurnId: turnId });
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
      `TG Caveman: ${config.telegramCavemanMode}`,
      `CWD: ${displayPath(selectedWorkspaceCwd(chatId))}`,
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

async function setModel(chatId, value) {
  const model = normalizeDefault(value);
  state.updateChat(chatId, { settings: { ...state.getChat(chatId).settings, model } });
  await telegram.sendMessage(chatId, `Model set to: ${model || "(default)"}`, mainKeyboard());
}

async function setApproval(chatId, value) {
  const allowed = new Set(["untrusted", "on-request", "never", "on-failure"]);
  if (!allowed.has(value)) {
    await telegram.sendMessage(chatId, "Usage: /approval untrusted|on-request|never|on-failure", mainKeyboard());
    return;
  }
  state.updateChat(chatId, { settings: { ...state.getChat(chatId).settings, approvalPolicy: value } });
  await telegram.sendMessage(chatId, `Approval policy set to: ${value}`, mainKeyboard());
}

async function setSandbox(chatId, value) {
  const allowed = new Set(["read-only", "workspace-write", "danger-full-access"]);
  if (!allowed.has(value)) {
    await telegram.sendMessage(chatId, "Usage: /sandbox read-only|workspace-write|danger-full-access", mainKeyboard());
    return;
  }
  state.updateChat(chatId, { settings: { ...state.getChat(chatId).settings, sandbox: value } });
  await telegram.sendMessage(chatId, `Sandbox set to: ${value}`, mainKeyboard());
}

async function setCwd(chatId, value) {
  if (!value || !value.startsWith("/")) {
    await telegram.sendMessage(chatId, "Use /workdir to choose a directory.", mainKeyboard());
    return;
  }
  const cwd = validateAllowedDirectory(value);
  if (!cwd.ok) {
    await telegram.sendMessage(chatId, cwd.message, mainKeyboard());
    return;
  }
  if (cwd.path === config.parentDir) {
    await telegram.sendMessage(chatId, "Choose a project directory inside /, not / itself.", mainKeyboard());
    return;
  }
  state.updateChat(chatId, { cwd: cwd.path });
  await telegram.sendMessage(chatId, `CWD set to:\n${displayPath(cwd.path)}`, mainKeyboard());
}

async function handleCallbackQuery(query) {
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

  const validation = validateAllowedDirectory(target.path);
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

async function showWorkdirPicker(chatId, cwd) {
  const validation = validateAllowedDirectory(cwd);
  if (!validation.ok) {
    await telegram.sendMessage(chatId, validation.message, mainKeyboard());
    return;
  }
  const view = buildWorkdirPicker(validation.path, 0);
  await telegram.sendMessage(chatId, view.text, {
    ...mainKeyboard(),
    reply_markup: view.replyMarkup,
  });
}

async function renderWorkdirPicker(chatId, messageId, cwd, page = 0) {
  const view = buildWorkdirPicker(cwd, page);
  await telegram.editMessageText(chatId, messageId, view.text, { reply_markup: view.replyMarkup });
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

  if (message.method === "turn/completed") {
    flushTurnBuffers(params.threadId, params.turn?.id, chatId);
    state.updateChat(chatId, { activeTurnId: null });
    return;
  }

  if (message.method === "error") {
    await telegram.sendMessage(chatId, `${message.method}: ${redactPaths(params.message || JSON.stringify(params))}`);
  }
}

function flushTurnBuffers(threadId, turnId, chatId) {
  for (const [key, value] of buffersByTurn.entries()) {
    if (!key.startsWith(`${threadId}:${turnId}:`)) continue;
    buffersByTurn.delete(key);
    if (value.trim()) void telegram.sendMessage(chatId, value);
  }
}

function helpText() {
  return [
    "Codex remote access commands:",
    "/new [cwd] - start a new persistent Codex thread",
    "/resume <thread-id> - resume a session from the selected working directory",
    "/sessions - list sessions in the selected working directory",
    "/workdir - choose a working directory under the allowed parent",
    "/settings - show Codex defaults for this Telegram chat",
    "/model <model|default> - set model for future turns",
    "/approval <policy> - set approval policy",
    "/sandbox <mode> - set sandbox mode for future threads",
    "/cwd <path> - set working directory under the allowed parent",
    "/status - show current mapping and CLI resume command",
    "/stop - interrupt the active Codex turn",
    "",
    "Any normal message is sent to the current Codex thread.",
  ].join("\n");
}

function mainKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "Workdir" }, { text: "Sessions" }],
        [{ text: "Status" }, { text: "Settings" }],
        [{ text: "New Thread" }, { text: "Stop" }],
        [{ text: "Help" }],
      ],
      resize_keyboard: true,
      is_persistent: true,
    },
  };
}

function commandForButton(text) {
  const commands = {
    workdir: "/workdir",
    sessions: "/sessions",
    status: "/status",
    settings: "/settings",
    "new thread": "/new",
    stop: "/stop",
    help: "/help",
  };
  return commands[text.trim().toLowerCase()] || null;
}

async function checkRateLimit({ userId, chatId = null, callbackQueryId = null }) {
  const now = Date.now();
  const windowMs = config.rateLimitWindowSeconds * 1000;
  const bucket = rateLimitBuckets.get(userId) || { resetAt: now + windowMs, count: 0 };

  if (now >= bucket.resetAt) {
    bucket.resetAt = now + windowMs;
    bucket.count = 0;
  }

  bucket.count += 1;
  rateLimitBuckets.set(userId, bucket);

  if (bucket.count <= config.rateLimitMaxUpdates) return true;

  const retrySeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  const message = `Rate limit hit. Try again in ${retrySeconds}s.`;
  if (callbackQueryId) {
    await telegram.answerCallbackQuery(callbackQueryId, message);
  } else if (chatId) {
    await telegram.sendMessage(chatId, message, mainKeyboard());
  }
  return false;
}

function buildWorkdirPicker(cwd, page = 0) {
  const allDirs = listChildDirectories(cwd);
  const pageCount = Math.max(1, Math.ceil(allDirs.length / WORKDIR_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const start = safePage * WORKDIR_PAGE_SIZE;
  const dirs = allDirs.slice(start, start + WORKDIR_PAGE_SIZE);
  const rows = [];

  if (cwd !== config.parentDir) {
    rows.push([{ text: "..", callback_data: workdirCallback(resolve(cwd, ".."), { action: "open" }) }]);
  }

  for (const dir of dirs) {
    rows.push([{ text: `${basename(dir)}/`, callback_data: workdirCallback(dir, { action: "open" }) }]);
  }

  const pageButtons = [];
  if (safePage > 0) {
    pageButtons.push({ text: "Prev", callback_data: workdirCallback(cwd, { action: "page", page: safePage - 1 }) });
  }
  if (safePage < pageCount - 1) {
    pageButtons.push({ text: "More", callback_data: workdirCallback(cwd, { action: "page", page: safePage + 1 }) });
  }
  if (pageButtons.length) {
    rows.push(pageButtons);
  }

  if (cwd !== config.parentDir) {
    rows.push([{ text: "Select this directory", callback_data: workdirCallback(cwd, { action: "select" }) }]);
  }

  return {
    text: [
      "Choose Codex working directory",
      "",
      "Parent: /",
      `Selected: ${displayPath(cwd)}`,
      `Page: ${safePage + 1}/${pageCount}`,
      "",
      allDirs.length ? "Open a folder or select this directory." : "No child directories found.",
    ].join("\n"),
    replyMarkup: { inline_keyboard: rows },
  };
}

function listChildDirectories(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => resolve(dir, entry.name))
    .filter(isAllowedPath)
    .filter((path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => basename(a).localeCompare(basename(b)));
}

function workdirCallback(path, metadata = {}) {
  const token = Math.random().toString(36).slice(2, 10);
  workdirTokens.set(token, { path, ...metadata });
  return `wd|${token}`;
}

function validateAllowedDirectory(value) {
  const path = resolve(value);
  if (!isAllowedPath(path)) {
    return { ok: false, message: "Path is outside the allowed parent." };
  }
  if (!existsSync(path)) return { ok: false, message: `Path does not exist:\n${displayPath(path)}` };
  const realPath = realpathSync(path);
  if (!isAllowedPath(realPath)) {
    return {
      ok: false,
      message: "Path resolves outside the allowed parent.",
    };
  }
  try {
    if (!statSync(realPath).isDirectory()) return { ok: false, message: `Path is not a directory:\n${displayPath(realPath)}` };
  } catch {
    return { ok: false, message: `Cannot read directory:\n${displayPath(realPath)}` };
  }
  return { ok: true, path: realPath };
}

function requireAllowedDirectory(value) {
  const validation = validateAllowedDirectory(value);
  if (!validation.ok) throw new Error(validation.message);
  return validation.path;
}

function requireWorkspaceDirectory(value) {
  const path = requireAllowedDirectory(value);
  if (path === config.parentDir) {
    throw new Error("Choose a project directory inside / before starting or listing sessions.");
  }
  return path;
}

function selectedWorkspaceCwd(chatId) {
  const cwd = state.getChat(chatId).cwd;
  if (!cwd || cwd === config.parentDir) return config.defaultCwd;
  return cwd;
}

function isAllowedPath(path) {
  const resolvedPath = resolve(path);
  const resolvedParent = resolve(config.parentDir);
  const rel = relative(resolvedParent, resolvedPath);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && rel !== "..");
}

function displayPath(path) {
  const resolvedPath = resolve(path);
  const rel = relative(config.parentDir, resolvedPath);
  if (rel === "") return "/";
  if (rel.startsWith("..") || rel.startsWith("/")) return "[outside-parent]";
  return `/${rel}`;
}

function redactPaths(text) {
  return String(text).split(config.parentDir).join("");
}

async function findThreadInSelectedCwd(chatId, threadId) {
  const cwd = requireWorkspaceDirectory(selectedWorkspaceCwd(chatId));
  let cursor = null;
  for (let page = 0; page < 5; page += 1) {
    const result = await codex.listThreads({ cwd, limit: 50, cursor });
    const match = result.data?.find((thread) => thread.id === threadId);
    if (match) return match;
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return null;
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

function telegramDeveloperInstructions() {
  if (config.telegramCavemanMode === "off") return null;
  return `Use caveman ${config.telegramCavemanMode} mode.`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

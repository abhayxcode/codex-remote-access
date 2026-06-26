const TELEGRAM_LIMIT = 4096;
const SAFE_LIMIT = 3600;

export class TelegramClient {
  constructor(token) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.offset = 0;
  }

  async poll() {
    const url = new URL(`${this.baseUrl}/getUpdates`);
    url.searchParams.set("timeout", "30");
    url.searchParams.set("offset", String(this.offset));
    url.searchParams.set("allowed_updates", JSON.stringify(["message", "callback_query"]));
    const res = await fetch(url);
    const payload = await res.json();
    if (!payload.ok) throw new Error(`Telegram getUpdates failed: ${payload.description}`);
    for (const update of payload.result) {
      this.offset = Math.max(this.offset, update.update_id + 1);
    }
    return payload.result;
  }

  async sendMessage(chatId, text, options = {}) {
    const chunks = splitTelegramMessage(text || "(empty)");
    let last;
    for (const chunk of chunks) {
      last = await this.call("sendMessage", {
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
        ...options,
      });
    }
    return last;
  }

  async sendChatAction(chatId, action = "typing") {
    try {
      await this.call("sendChatAction", { chat_id: chatId, action });
    } catch {
      // Non-critical; Telegram may reject actions during transient chat states.
    }
  }

  async editMessageText(chatId, messageId, text, options = {}) {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
      ...options,
    });
  }

  async answerCallbackQuery(callbackQueryId, text = "") {
    return this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
      show_alert: false,
    });
  }

  async call(method, body) {
    const res = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await res.json();
    if (!payload.ok) throw new Error(`Telegram ${method} failed: ${payload.description}`);
    return payload.result;
  }
}

export function getMessageText(update) {
  const message = update.message;
  if (!message) return null;
  return message.text || message.caption || null;
}

function splitTelegramMessage(text) {
  if (text.length <= TELEGRAM_LIMIT) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    let cut = Math.min(SAFE_LIMIT, remaining.length);
    const newline = remaining.lastIndexOf("\n", cut);
    if (newline > 500) cut = newline;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  return chunks;
}

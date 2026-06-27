const TELEGRAM_LIMIT = 4096;
const SAFE_LIMIT = 3600;

export type TelegramChatId = string | number;

type TelegramApiResponse<T> = {
  ok: boolean;
  result: T;
  description?: string;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

export type TelegramMessage = {
  message_id: number;
  chat: { id: TelegramChatId };
  from?: { id: number };
  text?: string;
  caption?: string;
};

export type TelegramCallbackQuery = {
  id: string;
  from?: { id: number };
  message?: TelegramMessage;
  data?: string;
};

type TelegramOptions = Record<string, any>;

export class TelegramClient {
  private baseUrl: string;
  private offset = 0;

  constructor(token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async poll(): Promise<TelegramUpdate[]> {
    const url = new URL(`${this.baseUrl}/getUpdates`);
    url.searchParams.set("timeout", "30");
    url.searchParams.set("offset", String(this.offset));
    url.searchParams.set("allowed_updates", JSON.stringify(["message", "callback_query"]));
    const res = await fetch(url);
    const payload = await res.json() as TelegramApiResponse<TelegramUpdate[]>;
    if (!payload.ok) throw new Error(`Telegram getUpdates failed: ${payload.description}`);
    for (const update of payload.result) {
      this.offset = Math.max(this.offset, update.update_id + 1);
    }
    return payload.result;
  }

  async sendMessage(chatId: TelegramChatId, text: string, options: TelegramOptions = {}) {
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

  async sendChatAction(chatId: TelegramChatId, action = "typing") {
    try {
      await this.call("sendChatAction", { chat_id: chatId, action });
    } catch {
      // Non-critical; Telegram may reject actions during transient chat states.
    }
  }

  async editMessageText(chatId: TelegramChatId, messageId: number, text: string, options: TelegramOptions = {}) {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
      ...options,
    });
  }

  async answerCallbackQuery(callbackQueryId: string, text = "") {
    return this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
      show_alert: false,
    });
  }

  async call<T = any>(method: string, body: Record<string, any>): Promise<T> {
    const res = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await res.json() as TelegramApiResponse<T>;
    if (!payload.ok) throw new Error(`Telegram ${method} failed: ${payload.description}`);
    return payload.result;
  }
}

export function getMessageText(update: TelegramUpdate) {
  const message = update.message;
  if (!message) return null;
  return message.text || message.caption || null;
}

function splitTelegramMessage(text: string) {
  if (text.length <= TELEGRAM_LIMIT) return [text];
  const chunks: string[] = [];
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

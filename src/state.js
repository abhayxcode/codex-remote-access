import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class StateStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.path = join(dataDir, "state.json");
    this.state = { chats: {} };
    mkdirSync(dataDir, { recursive: true });
    this.load();
  }

  load() {
    try {
      this.state = JSON.parse(readFileSync(this.path, "utf8"));
      if (!this.state.chats) this.state.chats = {};
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  save() {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`);
    renameSync(tmp, this.path);
  }

  getChat(chatId) {
    const key = String(chatId);
    if (!this.state.chats[key]) {
      this.state.chats[key] = {
        threadId: null,
        cwd: null,
        activeTurnId: null,
        settings: {},
      };
    }
    if (!this.state.chats[key].settings) this.state.chats[key].settings = {};
    return this.state.chats[key];
  }

  updateChat(chatId, patch) {
    const chat = this.getChat(chatId);
    Object.assign(chat, patch);
    this.save();
    return chat;
  }
}

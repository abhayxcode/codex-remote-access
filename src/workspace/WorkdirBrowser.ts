import { readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { WorkspaceScope } from "./WorkspaceScope.js";

export type WorkdirAction = "open" | "page" | "select";

export type WorkdirToken = {
  path: string;
  action?: WorkdirAction;
  page?: number;
};

export type InlineButton = {
  text: string;
  callback_data: string;
};

export type WorkdirPickerView = {
  text: string;
  replyMarkup: { inline_keyboard: InlineButton[][] };
};

export class WorkdirBrowser {
  constructor(
    private readonly scope: WorkspaceScope,
    private readonly pageSize = 20,
  ) {}

  buildPicker(cwd: string, page: number, callbackFor: (path: string, metadata?: Omit<WorkdirToken, "path">) => string): WorkdirPickerView {
    const allDirs = this.listChildDirectories(cwd);
    const pageCount = Math.max(1, Math.ceil(allDirs.length / this.pageSize));
    const safePage = Math.min(Math.max(page, 0), pageCount - 1);
    const start = safePage * this.pageSize;
    const dirs = allDirs.slice(start, start + this.pageSize);
    const rows: InlineButton[][] = [];

    if (cwd !== this.scope.parentDir) {
      rows.push([{ text: "..", callback_data: callbackFor(resolve(cwd, ".."), { action: "open" }) }]);
    }

    for (const dir of dirs) {
      rows.push([{ text: `${basename(dir)}/`, callback_data: callbackFor(dir, { action: "open" }) }]);
    }

    const pageButtons: InlineButton[] = [];
    if (safePage > 0) {
      pageButtons.push({ text: "Prev", callback_data: callbackFor(cwd, { action: "page", page: safePage - 1 }) });
    }
    if (safePage < pageCount - 1) {
      pageButtons.push({ text: "More", callback_data: callbackFor(cwd, { action: "page", page: safePage + 1 }) });
    }
    if (pageButtons.length) rows.push(pageButtons);

    if (cwd !== this.scope.parentDir) {
      rows.push([{ text: "Select this directory", callback_data: callbackFor(cwd, { action: "select" }) }]);
    }

    return {
      text: [
        "Choose Codex working directory",
        "",
        "Parent: /",
        `Selected: ${this.scope.displayPath(cwd)}`,
        `Page: ${safePage + 1}/${pageCount}`,
        "",
        allDirs.length ? "Open a folder or select this directory." : "No child directories found.",
      ].join("\n"),
      replyMarkup: { inline_keyboard: rows },
    };
  }

  private listChildDirectories(dir: string) {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => resolve(dir, entry.name))
      .filter((path) => this.scope.isAllowedPath(path))
      .filter((path) => {
        try {
          return statSync(path).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a, b) => basename(a).localeCompare(basename(b)));
  }
}

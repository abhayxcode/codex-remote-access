export function helpText() {
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

export function mainKeyboard() {
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

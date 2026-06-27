export function commandForButton(text: string) {
  const commands: Record<string, string> = {
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

import { startTelegramCodexApp, stopTelegramCodexApp } from "./app/TelegramCodexApp.js";

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopTelegramCodexApp();
    process.exit(0);
  });
}

await startTelegramCodexApp();

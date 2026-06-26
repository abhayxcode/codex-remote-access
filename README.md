# codex-remote-access

Telegram remote access for persistent Codex CLI sessions.

The bot is a thin Telegram UI over `codex app-server`. It starts or resumes real
Codex threads, stores the Telegram chat to Codex thread mapping in
`data/state.json`, streams assistant output back to Telegram, and leaves the
thread resumable from the Codex CLI.

## Requirements

- Node.js 20+
- Codex CLI installed and authenticated on the machine running the bot
- A Telegram bot token from `@BotFather`
- Your numeric Telegram user ID

## Setup

```bash
cp .env.example .env
```

Edit `.env`:

```bash
TELEGRAM_BOT_TOKEN=123456:replace-me
TELEGRAM_ALLOWED_USER_IDS=123456789
CODEX_BIN=codex
CODEX_DEFAULT_CWD=/absolute/path/to/repo
CODEX_PARENT_DIR=/absolute/path/to/parent
```

If `npm start` fails with `spawn codex ENOENT`, set `CODEX_BIN` to the absolute
path printed by:

```bash
command -v codex
```

Run:

```bash
npm start
```

## Telegram Commands

- `/new [cwd]` starts a new persistent Codex thread.
- `/resume <thread-id>` attaches the Telegram chat to an existing Codex thread
  only when that thread belongs to the currently selected working directory.
- `/sessions` lists recent local Codex sessions in the currently selected
  working directory.
- `/workdir` opens a button-based directory picker under `CODEX_PARENT_DIR`.
- `/settings` shows the Codex defaults for this Telegram chat.
- `/model <model|default>` sets the model for future turns.
- `/approval <policy>` sets the approval policy.
- `/sandbox <mode>` sets the sandbox mode for future threads.
- `/cwd <path>` sets the working directory used by `/new` and future turns. The
  path must be inside `CODEX_PARENT_DIR`.
- `/status` shows the current thread mapping and CLI resume command.
- `/stop` interrupts the active Codex turn.
- Any normal message is sent to the current Codex thread.

Settings changed from Telegram are stored per chat in `data/state.json`. The
`.env` values are startup defaults.

## CLI Resume

The bot uses normal Codex app-server threads, so the same thread can be resumed
from the CLI:

```bash
codex resume <thread-id>
```

The thread ID is shown after `/new` and in `/status`.

## Security Notes

Keep the bot process on a trusted machine. The Telegram bot can ask Codex to read
and edit files in the configured workspace, so `TELEGRAM_ALLOWED_USER_IDS` is
required and should contain only your Telegram user ID.

Set `CODEX_PARENT_DIR` to the highest directory Telegram is allowed to browse.
The bot validates real paths, so symlinks cannot be used to escape this parent.

By default this project starts Codex with:

```bash
CODEX_APPROVAL_POLICY=on-request
CODEX_SANDBOX=workspace-write
```

Those settings keep Codex close to normal interactive CLI behavior. Tighten them
in `.env` if you want a more restrictive remote setup.

## Protocol Reference

The generated `schemas/` folder comes from:

```bash
codex app-server generate-ts --out ./schemas
```

It is included as a local reference for the app-server method and notification
shapes used by the bridge.

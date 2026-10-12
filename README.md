# pi-plan-build

PLAN/BUILD mode for the [pi coding agent](https://github.com/earendil-works/pi) — toggled with **Tab**.
Designed for local models (llama.cpp, one GPU): a mode switch never invalidates the KV-cache
prefix and never grows the context.

> **A letter to the readers**
>
> This project was created entirely by a local model: **Qwen3.8-27B (Q4)**, 200k context,
> on a single **RTX 3090 24GB** + 32GB RAM + a 12-core / 24-thread Xeon — no cloud APIs.
> Generation ran at 50–60 tok/s at the start of a session and drops to 20–32 tok/s once the
> context is already filled; every design decision in this package (static system-prompt contract,
> ~4-token ephemeral markers, zero context bloat) is a direct answer to that fading.
>
> The story is simple: pi was missing the plan/build workflow I had in opencode, so I wrote
> the task down and handed it to the model — and over many small iterations, bit by bit,
> we built this together. Take it, use it, break it, and make it better.

## What it does

- **Tab** (or `/plan`, `/build`, `pi --plan`) toggles between two modes:
  - `PLAN` — read-only: the harness blocks `edit` / `write` / `powershell` tool calls and
    restricts `bash` to a read-only allowlist. The model explores the codebase, asks
    clarifying questions, and finishes with a numbered plan under a `Plan:` header.
  - `BUILD` — normal operation, full tools. Executes the plan in order.
- Footer shows the current mode (TUI-only, never enters the prompt).
- Mode survives `/resume`, `/reload` and `/fork` (persisted as a zero-token session entry).

## How it works (KV-cache economics)

A request is `[system prompt | session history | mode marker]`. Prefix caches (llama.cpp)
stay warm only while the prefix is byte-identical:

1. **Static contract** — a `before_agent_start` hook appends a fixed, mode-*independent*
   section to the system prompt describing both modes. Byte-identical on every run →
   the prefix never changes on a toggle.
2. **Ephemeral marker (on change only)** — a `context` hook (fires before each LLM call)
   appends the current short marker `[MODE: PLAN]` / `[MODE: BUILD]` (~4 tokens) to a deep
   copy of the messages, but only when the model could have lost the mode: the first call
   of a session, a mode toggle, or a context reset (compaction / session swap — detected
   via a fingerprint of the first message). During a running task (unchanged mode, tool
   loop) the marker is **not** repeated — its absence means "the mode has not changed"
   (the contract says so). The copy is never written to the session, so toggling Tab 100×
   adds **zero** tokens to the context.
3. **State** — toggles persist `{mode}` via `pi.appendEntry("mode-state")` (custom
   entries do not participate in LLM context).
4. **Enforcement** — a `tool_call` hook blocks mutating tools and non-allowlisted bash
   in PLAN mode, so the active tool list (and therefore the system prompt) stays stable.

The pi `plan-mode` example instead changes the active tool set per mode and persists a
long context message per toggle. That is fine for API providers, but each tool-list
change invalidates the whole KV-cache prefix (full re-prefill) and each toggle
permanently bloats the context — the two failure modes this package avoids.

## Install

Requires pi ≥ 0.84.

```bash
# from git (pinned ref; update with: pi install git:github.com/Develeps/pi-plan-build@<new-ref>)
pi install git:github.com/Develeps/pi-plan-build@v1.0.0

# try from a local checkout without publishing (pi remove <same-spec> to undo)
pi install /absolute/path/to/pi-plan-build
```

If you previously had a local copy (e.g. `~/.pi/agent/extensions/plan-build.ts`), remove
it after installing the package — otherwise the extension loads twice.

> **Note:** the default toggle key is Tab, which overrides the editor's Tab-completion
> keybinding. Change `TOGGLE_KEY` at the top of `extensions/plan-build.ts` to reclaim it.

## Load filtering

```json
{
	"packages": [
		{
			"source": "git:github.com/Develeps/pi-plan-build@v1.0.0",
			"extensions": []
		}
	]
}
```

## Development

```bash
npm install   # jiti (dev only — pi provides it at runtime)
npm test      # mock-ExtensionAPI smoke test (37 checks)
```

## License

MIT

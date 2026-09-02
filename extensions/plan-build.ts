/**
 * PLAN / BUILD modes, switched with Tab — v3 (flat context).
 *
 * Problem v2 solved: a mode switch must NEVER change the request prefix
 * (system prompt / tool list). On local models (llama.cpp, one GPU) any
 * prefix change invalidates the KV cache → full re-prefill of the whole
 * context.
 *
 * Problem v3 fixes: v2 communicated the mode by PERSISTING a marker
 * message per toggle ("latest marker wins"). The PLAN marker is ~250
 * tokens; rapid tabbing (PLAN→BUILD→PLAN→…) permanently bloats the
 * session, and every full cache miss (server restart / eviction)
 * re-prefills that bloat too.
 *
 * v3 keeps the prefix byte-stable AND keeps the context flat:
 *
 *  1. CONTRACT (system prompt, static):
 *     before_agent_start appends a fixed, mode-INDEPENDENT section
 *     describing both modes + the marker convention, to the system
 *     prompt. Byte-identical on every run → the prefix never changes
 *     → toggling never invalidates the cache. (v1's mistake was making
 *     the system prompt mode-DEPENDENT.)
 *
 *  2. MARKER (ephemeral, ~4 tokens, tail):
 *     The `context` event fires before every LLM call with a deep copy
 *     of the messages. The handler (a) strips all persisted
 *     "mode-marker" messages (v2 legacy in old sessions), (b) appends
 *     the current short marker `[MODE: PLAN]` / `[MODE: BUILD]` at the
 *     very tail. The copy is used for this request only — it is never
 *     persisted → toggling (even 100×) adds zero tokens to the
 *     session; a toggle costs ~4 tail tokens of re-prefill on the next
 *     LLM call. Within a tool loop the marker sits after the fresh
 *     assistant/tool messages, which are new (re-prefilled) anyway.
 *
 *  3. STATE (appendEntry, zero LLM cost):
 *     Toggles persist `{mode}` via pi.appendEntry("mode-state") — a
 *     custom entry that does NOT participate in LLM context.
 *     session_start restores it (priority: --plan flag > last entry >
 *     "build"), so /resume, /reload and forks keep mode + enforcement.
 *     (v2 relied on markers in history, so a resume silently dropped
 *     back to "build" while the footer lied — this fixes that too.)
 *
 *  4. ENFORCEMENT (code-side, unchanged from v2):
 *     PLAN mode blocks edit / write / powershell tool calls and bash
 *     outside the read-only allowlist. The tool list stays active and
 *     stable, so the model still sees the tools and gets a blocking
 *     error on misuse — the intended trade on a single GPU.
 *
 * Side effects of the v3 design:
 *  - Compaction can no longer desync the mode (the marker is
 *    re-injected on EVERY LLM call) → v2's turn_end re-sync detector
 *    is deleted.
 *  - Legacy v2 sessions: their persisted long markers are stripped
 *    from the LLM's view from the first call after /reload (one-time
 *    re-prefill), then the context is flat again.
 *
 * Controls: Tab (toggle; overrides editor Tab autocomplete — change
 * TOGGLE_KEY to reclaim it), /plan, /build, `pi --plan` (start in
 * PLAN). Footer status is TUI-only (never enters the prompt).
 *
 * Bash allowlist: ported from pi's plan-mode example; redirect pattern
 * refined so `2>&1` / `>&N` (fd-to-fd) pass while file redirects block;
 * redirects are scanned OUTSIDE quotes only, so `awk '$3 > 10' f` is not
 * mistaken for a write. Word patterns still scan the RAW command, which
 * keeps `awk 'system("rm -rf /")'` blocked on the word itself.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Mode = "plan" | "build";

const TOGGLE_KEY = "tab";

// Custom MESSAGE type for the ephemeral marker. v2 persisted markers with
// this same type — the context handler strips them (legacy cleanup).
const MODE_MARKER = "mode-marker";

// Custom ENTRY type for persisted mode state (invisible to the LLM).
const MODE_STATE = "mode-state";

// Fixed timestamp keeps the ephemeral marker byte-identical across calls
// (provider payloads never include it, but determinism is free).
const MARKER_TS = Date.now();

export const PLAN_MARKER_TEXT = "[MODE: PLAN]";
export const BUILD_MARKER_TEXT = "[MODE: BUILD]";

// Static contract: appended to the system prompt on every run, identical
// in both modes → KV prefix stable across toggles. The marker at the
// tail of the message list is the only mode-specific bytes.
export const MODE_CONTRACT = `## Plan/Build modes
This session runs in one of two modes. A marker line — ${PLAN_MARKER_TEXT} or ${BUILD_MARKER_TEXT} — is appended at the very end of the message list on every request; it states the current mode and is authoritative (any older [MODE] markers in the history are stale — ignore them). The user switches modes with Tab (or /plan, /build).

- ${PLAN_MARKER_TEXT} — read-only analysis and planning. The harness enforces this: edit / write / powershell tool calls are blocked, and bash is limited to read-only allowlisted commands (blocked calls return an error — do not retry them). Your task: 1) explore and understand the codebase with read-only tools; 2) ask clarifying questions if the request is ambiguous; 3) finish with a concrete numbered plan under a "Plan:" header, each step naming the files to change; 4) do NOT implement anything and never present unexecuted changes as done.
- ${BUILD_MARKER_TEXT} — normal operation: full tools enabled, PLAN restrictions lifted. If a plan was produced in PLAN mode, execute its steps in order.`;

// Tools blocked by the harness in PLAN mode (list itself stays active & stable)
const WRITE_TOOLS = new Set(["edit", "write", "powershell"]);

// --- Bash allowlist ---------------------------------------------------------

const WORD_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

// Redirects outside quotes only: `cat f > g` is a write, `awk '$3 > 10' f` is not.
const REDIRECT_PATTERNS = [
	/(^|[^<])>(?!&)/, // file redirect; 2>&1 / >&N (fd-to-fd) is safe
	/>>/,
];

function stripQuotes(command: string): string {
	return command.replace(/"([^"\\]|\\.)*"/g, " ").replace(/'[^']*'/g, " ");
}

export function isSafeCommand(command: string): boolean {
	const destructive =
		WORD_PATTERNS.some((p) => p.test(command)) ||
		REDIRECT_PATTERNS.some((p) => p.test(stripQuotes(command)));
	const safe = SAFE_PATTERNS.some((p) => p.test(command));
	return !destructive && safe;
}

// Type guard for the ephemeral/legacy marker (robust under any AgentMessage
// union the `context` event hands us).
function isModeMarker(m: unknown): boolean {
	return (
		typeof m === "object" &&
		m !== null &&
		(m as { role?: unknown }).role === "custom" &&
		(m as { customType?: unknown }).customType === MODE_MARKER
	);
}

export default function planBuildExtension(pi: ExtensionAPI): void {
	let mode: Mode = "build";
	let persistedMode: Mode | null = null;

	function persistMode(): void {
		if (persistedMode === mode) return;
		persistedMode = mode;
		try {
			pi.appendEntry(MODE_STATE, { mode });
		} catch {
			/* non-fatal */
		}
	}

	function markerText(): string {
		return mode === "plan" ? PLAN_MARKER_TEXT : BUILD_MARKER_TEXT;
	}

	function updateStatus(ctx?: ExtensionContext): void {
		if (!ctx) return;
		ctx.ui.setStatus(
			"plan-build",
			mode === "plan"
				? ctx.ui.theme.fg("warning", "⏸ PLAN  [tab→build]")
				: ctx.ui.theme.fg("muted", "▶ BUILD  [tab→plan]"),
		);
	}

	// Toggle = in-process state + zero-cost entry + TUI feedback.
	// The model sees the change on the NEXT LLM call (ephemeral marker),
	// enforcement flips immediately (tool_call hook reads `mode`).
	function setMode(next: Mode, ctx?: ExtensionContext): void {
		if (next === mode) return;
		mode = next;
		persistMode();
		ctx?.ui.notify(
			mode === "plan"
				? "⏸ PLAN: read-only (edit/write blocked, bash allowlist). Tab → build"
				: "🔨 BUILD: полные инструменты. Tab → plan",
			"info",
		);
		updateStatus(ctx);
	}

	pi.registerFlag("plan", {
		description: "Start in PLAN mode (read-only)",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("plan", {
		description: "Войти в PLAN (read-only; Tab — переключение)",
		handler: (_args, ctx) => setMode("plan", ctx),
	});

	pi.registerCommand("build", {
		description: "Войти в BUILD (полные инструменты; Tab — переключение)",
		handler: (_args, ctx) => setMode("build", ctx),
	});

	pi.registerShortcut(TOGGLE_KEY, {
		description: "Toggle PLAN/BUILD mode",
		handler: (ctx) => setMode(mode === "plan" ? "build" : "plan", ctx),
	});

	pi.on("session_start", async (_event, ctx) => {
		// Restore mode: --plan flag > last persisted entry > "build".
		let restored: Mode | undefined;
		try {
			const entries = ctx.sessionManager.getEntries();
			for (let i = entries.length - 1; i >= 0; i--) {
				const e = entries[i] as { type?: string; customType?: string; data?: { mode?: string } };
				if (
					e.type === "custom" &&
					e.customType === MODE_STATE &&
					(e.data?.mode === "plan" || e.data?.mode === "build")
				) {
					restored = e.data!.mode as Mode;
					break;
				}
			}
		} catch {
			/* non-fatal */
		}

		mode = pi.getFlag("plan") === true ? "plan" : restored ?? "build";
		// Persist only a non-default state that is not already recorded
		// (e.g. fresh start via --plan); a bare "build" default needs no entry.
		if (restored !== mode && mode !== "build") persistMode();
		updateStatus(ctx);
	});

	// Static contract: identical on every run → prefix byte-stable.
	pi.on("before_agent_start", (event) => {
		return { systemPrompt: event.systemPrompt + "\n\n" + MODE_CONTRACT };
	});

	// Ephemeral tail marker, injected before EVERY LLM call. The returned
	// messages replace the request only — the session file is untouched,
	// so toggling never grows the context. Stripping persisted markers
	// also cleans up v2 legacy from old sessions (one-time re-prefill).
	pi.on("context", (event) => {
		return {
			messages: [
				...event.messages.filter((m) => !isModeMarker(m)),
				{
					role: "custom" as const,
					customType: MODE_MARKER,
					content: markerText(),
					display: false,
					timestamp: MARKER_TS,
				},
			],
		};
	});

	// Enforcement: PLAN mode blocks mutating tools and non-allowlisted bash.
	// No tool-list or system-prompt changes → KV cache stays warm across switches.
	pi.on("tool_call", (event) => {
		if (mode !== "plan") return;

		if (WRITE_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason:
					"PLAN mode: file modifications are blocked (see the Plan/Build section of the system prompt and the [MODE] marker). " +
					"The user can press Tab to switch to BUILD mode.",
			};
		}

		if (event.toolName === "bash") {
			const command = event.input.command as string;
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `PLAN mode: command not on the read-only allowlist.\nCommand: ${command}`,
				};
			}
		}
	});
}

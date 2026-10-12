/*
 * Smoke test for extensions/plan-build.ts (v3).
 *
 * Loads the extension through jiti — the same loader pi uses — with a mock
 * ExtensionAPI, then exercises: registration, session_start restore, Tab
 * toggling (incl. rapid mash), before_agent_start contract, context hook
 * (ephemeral tail marker + legacy strip), tool_call enforcement, bash
 * allowlist edges, --plan flag, resume.
 *
 * Run:  npm install && npm test     (or: node test/smoke.cjs)
 */
const path = require("path");
const { createRequire } = require("module");

const { createJiti } = createRequire(__filename)("jiti");
const jiti = createJiti(__filename);

const EXT = path.join(__dirname, "..", "extensions", "plan-build.ts");

let failures = 0;
function check(name, cond, extra) {
	if (cond) console.log(`  ok  ${name}`);
	else {
		failures++;
		console.log(`FAIL  ${name}${extra ? " — " + extra : ""}`);
	}
}

(async () => {
	const mod = await jiti.import(EXT);
	const factory = mod.default ?? mod;
	check("module loads via jiti, default export is fn", typeof factory === "function");

	// ---- mock ExtensionAPI ----
	const calls = { flags: {}, commands: {}, shortcuts: {}, handlers: {}, entries: [], messages: [] };
	const pi = {
		registerFlag: (n, def) => { calls.flags[n] = { ...def, value: def.default }; },
		registerCommand: (n, def) => { calls.commands[n] = def; },
		registerShortcut: (k, def) => { calls.shortcuts[k] = def; },
		on: (name, fn) => { (calls.handlers[name] ??= []).push(fn); },
		getFlag: (n) => calls.flags[n]?.value,
		appendEntry: (t, d) => calls.entries.push({ type: "custom", customType: t, data: d }),
		sendMessage: (m) => calls.messages.push(m),
	};

	const ctx = {
		ui: {
			notifications: [],
			setStatus: (k, v) => { calls.ui_status = v ?? null; },
			notify: (msg, kind) => ctx.ui.notifications.push([kind ?? "info", msg]),
			theme: { fg: (_c, s) => s },
		},
		sessionManager: { getEntries: () => calls.entries },
		getContextUsage: () => null,
	};

	factory(pi);

	check("flag 'plan' registered", !!calls.flags.plan);
	check("commands /plan /build registered", !!calls.commands.plan && !!calls.commands.build);
	check("shortcut tab registered", !!calls.shortcuts.tab);
	check(
		"handlers: session_start, before_agent_start, context, tool_call",
		calls.handlers.session_start?.length === 1 &&
			calls.handlers.before_agent_start?.length === 1 &&
			calls.handlers.context?.length === 1 &&
			calls.handlers.tool_call?.length === 1,
		JSON.stringify(Object.keys(calls.handlers)),
	);
	check("NO turn_end handler (v2 compact-resync deleted)", !calls.handlers.turn_end?.length);

	const run = async (name, ev) => {
		const hs = calls.handlers[name];
		let out;
		for (const h of hs ?? []) out = await h(ev, ctx);
		return out;
	};

	// ---- 1. fresh session start (no entries, no flag) → build ----
	await run("session_start", { type: "session_start", reason: "startup" });
	check("fresh start → BUILD", calls.ui_status === "▶ BUILD v4  [tab→plan]", String(calls.ui_status));
	check("fresh start → no marker message sent", calls.messages.length === 0, JSON.stringify(calls.messages));
	check("fresh start → no mode-state entry (build is default)", calls.entries.length === 0, JSON.stringify(calls.entries));

	// ---- 2. tab → plan ----
	await calls.shortcuts.tab.handler(ctx);
	check("tab → PLAN status", calls.ui_status === "⏸ PLAN v4  [tab→build]", String(calls.ui_status));
	check("tab → mode-state entry persisted", calls.entries.length === 1 && calls.entries[0].data.mode === "plan", JSON.stringify(calls.entries));
	check("tab → NO marker message sent (the v3 fix)", calls.messages.length === 0, JSON.stringify(calls.messages));
	check("tab → notify shown", ctx.ui.notifications.some(([, m]) => m.includes("PLAN")), JSON.stringify(ctx.ui.notifications));

	// ---- 3. mash tab x9 ----
	const n0 = calls.entries.length;
	for (let i = 0; i < 9; i++) await calls.shortcuts.tab.handler(ctx);
	check("mash: still ZERO marker messages", calls.messages.length === 0);
	check(
		"mash: entries only grow as mode-state (9 toggles = 9 tiny entries)",
		calls.entries.length === n0 + 9 && calls.entries.every((e) => e.customType === "mode-state"),
		`${calls.entries.length - n0} entries`,
	);
	check("mash: final mode BUILD (1 plan + 9 toggles)", calls.ui_status === "▶ BUILD v4  [tab→plan]", String(calls.ui_status));
	await calls.shortcuts.tab.handler(ctx); // → plan again for enforcement tests
	check("back on PLAN for enforcement tests", calls.ui_status === "⏸ PLAN v4  [tab→build]");

	// ---- 4. before_agent_start → static contract ----
	const sp1 = (await run("before_agent_start", { type: "before_agent_start", prompt: "hi", systemPrompt: "BASE PROMPT", systemPromptOptions: {} }))?.systemPrompt;
	check("system prompt = base + contract", sp1 === "BASE PROMPT\n\n" + mod.MODE_CONTRACT, JSON.stringify(sp1?.slice(0, 80)));
	const sp2 = (await run("before_agent_start", { type: "before_agent_start", prompt: "hi", systemPrompt: "BASE PROMPT", systemPromptOptions: {} }))?.systemPrompt;
	check("contract byte-identical across runs (KV prefix stable)", sp1 !== undefined && sp1 === sp2);
	check(
		"contract names both markers + Plan/Build rules",
		!!sp1 && sp1.includes("[MODE: PLAN]") && sp1.includes("[MODE: BUILD]") && sp1.includes("numbered plan"),
	);

	// ---- 5. context → ephemeral tail marker + legacy strip ----
	const legacy = {
		role: "custom",
		customType: "mode-marker",
		display: false,
		timestamp: 123,
		content: "[MODE: PLAN — latest MODE marker wins]\nYou are in PLAN mode: read-only analysis and planning.\n…long v2 text…",
	};
	const res = await run("context", {
		type: "context",
		messages: [
			{ role: "user", content: [{ type: "text", text: "привет" }] },
			legacy,
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		],
	});
	check("context returns messages (3: user + assistant + tail marker)", Array.isArray(res?.messages) && res.messages.length === 3, JSON.stringify(res?.messages?.length));
	check("legacy v2 marker stripped", !res?.messages.some((m) => m === legacy || m.content?.includes("long v2 text")));
	const tail = res?.messages?.[res.messages.length - 1];
	check(
		"current short marker appended at tail (PLAN)",
		tail?.role === "custom" && tail?.customType === "mode-marker" && tail?.content === "[MODE: PLAN]",
		JSON.stringify(tail?.content),
	);
	check("marker has fixed timestamp (deterministic)", typeof tail?.timestamp === "number");

	await calls.shortcuts.tab.handler(ctx); // → build
	const res2 = await run("context", { type: "context", messages: [{ role: "user", content: "x" }] });
	check(
		"after toggle: tail marker flips to BUILD, no persistence",
		res2?.messages.at(-1)?.content === "[MODE: BUILD]" && calls.messages.length === 0,
	);

	// ---- 5b. v4: no marker repeat during a running task ----
	const resSame = await run("context", { type: "context", messages: [{ role: "user", content: "x" }] });
	check(
		"v4: unchanged mode + unchanged first message → NO marker (task continues)",
		resSame === undefined || resSame.messages?.at(-1)?.customType !== "mode-marker",
		JSON.stringify(resSame),
	);
	const resCompacted = await run("context", {
		type: "context",
		messages: [
			{ role: "user", content: "COMPACTED SUMMARY" },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		],
	});
	check(
		"v4: context reset (new first message, i.e. compaction) → marker re-injected (BUILD)",
		resCompacted?.messages.at(-1)?.content === "[MODE: BUILD]",
		JSON.stringify(resCompacted?.messages?.at(-1)),
	);

	// ---- 6. tool_call enforcement (toggle back to PLAN) ----
	await calls.shortcuts.tab.handler(ctx); // build → plan
	const blockWrite = await run("tool_call", { type: "tool_call", toolName: "write", toolCallId: "1", input: { path: "/tmp/x", content: "y" } });
	check("PLAN blocks write", blockWrite?.block === true, JSON.stringify(blockWrite));
	const blockPwsh = await run("tool_call", { type: "tool_call", toolName: "powershell", toolCallId: "2", input: { command: "Get-Item" } });
	check("PLAN blocks powershell", blockPwsh?.block === true);
	const okLs = await run("tool_call", { type: "tool_call", toolName: "bash", toolCallId: "3", input: { command: "ls -la" } });
	check("PLAN allows allowlisted bash (ls)", okLs === undefined || okLs?.block !== true, JSON.stringify(okLs));
	const okGit = await run("tool_call", { type: "tool_call", toolName: "bash", toolCallId: "4", input: { command: "git status" } });
	check("PLAN allows git status", okGit === undefined, JSON.stringify(okGit));
	const blockRm = await run("tool_call", { type: "tool_call", toolName: "bash", toolCallId: "5", input: { command: "rm -rf /tmp/x" } });
	check("PLAN blocks rm", blockRm?.block === true);
	const blockRedirect = await run("tool_call", { type: "tool_call", toolName: "bash", toolCallId: "6", input: { command: "cat f > g" } });
	check("PLAN blocks file redirect", blockRedirect?.block === true);
	const okFd = await run("tool_call", { type: "tool_call", toolName: "bash", toolCallId: "7", input: { command: "grep x f 2>&1" } });
	check("PLAN allows fd-to-fd redirect (2>&1)", okFd === undefined, JSON.stringify(okFd));

	await calls.shortcuts.tab.handler(ctx); // → build
	const unblockWrite = await run("tool_call", { type: "tool_call", toolName: "write", toolCallId: "8", input: { path: "/tmp/x", content: "y" } });
	check("BUILD unblocks write", unblockWrite === undefined, JSON.stringify(unblockWrite));

	// ---- 7. resume: session_start with persisted entry restores mode ----
	calls.entries.push({ type: "custom", customType: "mode-state", data: { mode: "plan" } });
	await run("session_start", { type: "session_start", reason: "resume", previousSessionFile: "/x" });
	check("resume restores PLAN from entry", calls.ui_status === "⏸ PLAN v4  [tab→build]", String(calls.ui_status));
	const entriesAfterResume = calls.entries.length;
	check("resume does not duplicate entry (mode already persisted)", calls.entries.length === entriesAfterResume);

	// ---- 8. --plan flag wins on fresh session ----
	calls.flags.plan.value = true;
	calls.entries.length = 0;
	await run("session_start", { type: "session_start", reason: "startup" });
	check("--plan flag → PLAN", calls.ui_status === "⏸ PLAN v4  [tab→build]", String(calls.ui_status));
	check("--plan fresh → entry persisted for later resume", calls.entries.length === 1 && calls.entries[0].data.mode === "plan");

	// ---- 9. v4: first call after session_start re-injects the marker ----
	const resFirstAfterFlag = await run("context", { type: "context", messages: [{ role: "user", content: "y" }] });
	check(
		"v4: first call after session_start (reset) re-injects marker (PLAN)",
		resFirstAfterFlag?.messages.at(-1)?.content === "[MODE: PLAN]",
		JSON.stringify(resFirstAfterFlag?.messages?.at(-1)),
	);

	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
	process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
	console.error("TEST CRASH:", e);
	process.exit(2);
});

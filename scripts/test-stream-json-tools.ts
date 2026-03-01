#!/usr/bin/env tsx
/**
 * Test 2: stream-json with tool use events.
 * Spawns Claude with a prompt that triggers a tool call,
 * then logs all events to see tool_use/tool_result schema.
 *
 * Usage: pnpm tsx scripts/test-stream-json-tools.ts
 */

import { spawn } from "node:child_process";

const CLAUDE_PATH = process.env.LEO_CLAUDE_PATH || "claude";

const tests = [
	{
		name: "verbose + include-partial (tool use)",
		args: [
			"-p",
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			"--max-turns",
			"2",
			"--dangerously-skip-permissions",
			'Read the file /tmp/stream-test.txt and tell me what it says.',
		],
	},
];

async function runTest(
	name: string,
	args: string[],
): Promise<void> {
	console.log(`\n${"=".repeat(60)}`);
	console.log(`TEST: ${name}`);
	console.log("=".repeat(60));

	// Create a test file for the tool to read
	const { writeFileSync } = await import("node:fs");
	writeFileSync("/tmp/stream-test.txt", "Stream JSON works!");

	return new Promise((resolve) => {
		const events: Array<{ type: string; [key: string]: unknown }> = [];
		let stdoutBuf = "";
		let stderrBuf = "";

		const env = { ...process.env };
		delete env.CLAUDECODE;

		const proc = spawn(CLAUDE_PATH, args, {
			env: {
				...env,
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
			},
			cwd: "/tmp",
			stdio: ["pipe", "pipe", "pipe"],
		});

		proc.stdout.on("data", (chunk: Buffer) => {
			stdoutBuf += chunk.toString();
			const lines = stdoutBuf.split("\n");
			stdoutBuf = lines.pop() || "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;

				try {
					const event = JSON.parse(trimmed);
					events.push(event);

					const type = event.type || "unknown";
					const subtype = event.subtype ? `:${event.subtype}` : "";

					// Compact logging based on event type
					switch (type) {
						case "system":
							if (event.subtype === "init") {
								console.log(`  [system:init] tools=${event.tools?.length}, model=${event.model}`);
							} else if (event.subtype === "hook_started") {
								console.log(`  [system:hook_started] ${event.hook_name}`);
							} else if (event.subtype === "hook_response") {
								console.log(`  [system:hook_response] ${event.hook_name} exit=${event.exit_code}`);
							} else {
								console.log(`  [system${subtype}] ${JSON.stringify(event).slice(0, 100)}`);
							}
							break;

						case "assistant": {
							const msg = event.message as { content?: Array<{ type: string; name?: string; text?: string; id?: string; input?: unknown }> };
							const blocks = msg?.content || [];
							for (const block of blocks) {
								if (block.type === "text") {
									console.log(`  [assistant:text] "${block.text?.slice(0, 100)}"`);
								} else if (block.type === "tool_use") {
									console.log(`  [assistant:tool_use] name=${block.name} id=${block.id} input=${JSON.stringify(block.input).slice(0, 100)}`);
								} else {
									console.log(`  [assistant:${block.type}] ${JSON.stringify(block).slice(0, 100)}`);
								}
							}
							break;
						}

						case "tool_result":
							console.log(`  [tool_result] id=${event.tool_use_id} content_len=${JSON.stringify(event.content).length}`);
							break;

						case "content_block_start":
							console.log(`  [content_block_start] index=${event.index} type=${(event.content_block as { type?: string })?.type}`);
							break;

						case "content_block_delta": {
							const delta = event.delta as { type?: string; text?: string; partial_json?: string };
							const preview = delta?.text?.slice(0, 50) || delta?.partial_json?.slice(0, 50) || "";
							console.log(`  [content_block_delta] index=${event.index} delta_type=${delta?.type} "${preview}"`);
							break;
						}

						case "content_block_stop":
							console.log(`  [content_block_stop] index=${event.index}`);
							break;

						case "result":
							console.log(`  [result] cost=$${event.total_cost_usd} duration=${event.duration_ms}ms turns=${event.num_turns}`);
							break;

						case "rate_limit_event":
							console.log(`  [rate_limit] status=${(event.rate_limit_info as { status?: string })?.status}`);
							break;

						default:
							console.log(`  [${type}${subtype}] ${JSON.stringify(event).slice(0, 120)}`);
					}
				} catch {
					console.log(`  [RAW] ${trimmed.slice(0, 200)}`);
				}
			}
		});

		proc.stderr.on("data", (chunk: Buffer) => {
			stderrBuf += chunk.toString();
		});

		const timeout = setTimeout(() => {
			console.log("  [TIMEOUT] Killing after 60s");
			proc.kill("SIGTERM");
		}, 60_000);

		proc.on("close", (code) => {
			clearTimeout(timeout);

			if (stdoutBuf.trim()) {
				try {
					const event = JSON.parse(stdoutBuf.trim());
					events.push(event);
				} catch { /* ignore */ }
			}

			if (stderrBuf.trim()) {
				console.log(`\n  STDERR:\n    ${stderrBuf.trim().split("\n").join("\n    ")}`);
			}

			console.log(`\n  Exit code: ${code}`);

			// Event type distribution
			const typeCounts: Record<string, number> = {};
			for (const e of events) {
				const key = e.subtype ? `${e.type}:${e.subtype}` : e.type;
				typeCounts[key] = (typeCounts[key] || 0) + 1;
			}
			console.log(`  Event types: ${JSON.stringify(typeCounts, null, 2)}`);

			// Dump tool_use and tool_result events in full
			console.log("\n  --- Tool events (full) ---");
			for (const e of events) {
				if (e.type === "assistant") {
					const msg = e.message as { content?: Array<{ type: string }> };
					const hasToolUse = msg?.content?.some(b => b.type === "tool_use");
					if (hasToolUse) {
						console.log(`  ${JSON.stringify(e, null, 2).split("\n").join("\n  ")}`);
					}
				}
				if (e.type === "tool_result") {
					console.log(`  ${JSON.stringify(e, null, 2).split("\n").join("\n  ")}`);
				}
			}

			resolve();
		});

		proc.stdin.end();
	});
}

async function main() {
	console.log("Stream-JSON Tool Use Test");
	console.log(`Claude CLI: ${CLAUDE_PATH}`);

	for (const test of tests) {
		await runTest(test.name, test.args);
	}

	console.log("\n" + "=".repeat(60));
	console.log("Done.");
}

main().catch(console.error);

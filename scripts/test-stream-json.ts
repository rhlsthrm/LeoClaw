#!/usr/bin/env tsx
/**
 * Targeted test: spawn Claude CLI with --output-format stream-json
 * and log every NDJSON event to understand the schema.
 *
 * Usage: pnpm tsx scripts/test-stream-json.ts
 */

import { spawn } from "node:child_process";

const CLAUDE_PATH = process.env.LEO_CLAUDE_PATH || "claude";
const PROMPT = 'Say "hello world" and nothing else.';

// Test matrix: try without --verbose first (the constraint that broke last time)
const tests = [
	{
		name: "stream-json (no --verbose)",
		args: ["-p", "--output-format", "stream-json", PROMPT],
	},
	{
		name: "stream-json + --verbose",
		args: ["-p", "--output-format", "stream-json", "--verbose", PROMPT],
	},
	{
		name: "stream-json + --include-partial-messages",
		args: [
			"-p",
			"--output-format",
			"stream-json",
			"--include-partial-messages",
			PROMPT,
		],
	},
];

async function runTest(
	name: string,
	args: string[],
): Promise<{ events: unknown[]; stderr: string; exitCode: number | null }> {
	return new Promise((resolve) => {
		console.log(`\n${"=".repeat(60)}`);
		console.log(`TEST: ${name}`);
		console.log(`CMD: ${CLAUDE_PATH} ${args.join(" ")}`);
		console.log("=".repeat(60));

		const events: unknown[] = [];
		let stderrBuf = "";
		let stdoutBuf = "";

		const env = { ...process.env };
		delete env.CLAUDECODE; // Allow nested spawning

		const proc = spawn(CLAUDE_PATH, args, {
			env: {
				...env,
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
			},
			cwd: "/tmp", // Neutral directory, no CLAUDE.md loaded
			stdio: ["pipe", "pipe", "pipe"],
		});

		proc.stdout.on("data", (chunk: Buffer) => {
			stdoutBuf += chunk.toString();
			// NDJSON = one JSON object per line
			const lines = stdoutBuf.split("\n");
			// Keep the last incomplete line in the buffer
			stdoutBuf = lines.pop() || "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;

				try {
					const event = JSON.parse(trimmed);
					events.push(event);

					// Log event type and key fields
					const type = event.type || "unknown";
					const summary = summarizeEvent(event);
					console.log(`  [${type}] ${summary}`);
				} catch {
					console.log(`  [RAW] ${trimmed.slice(0, 200)}`);
				}
			}
		});

		proc.stderr.on("data", (chunk: Buffer) => {
			stderrBuf += chunk.toString();
		});

		// 30s timeout
		const timeout = setTimeout(() => {
			console.log("  [TIMEOUT] Killing after 30s");
			proc.kill("SIGTERM");
		}, 30_000);

		proc.on("close", (code) => {
			clearTimeout(timeout);

			// Flush remaining buffer
			if (stdoutBuf.trim()) {
				try {
					const event = JSON.parse(stdoutBuf.trim());
					events.push(event);
					console.log(
						`  [${event.type || "unknown"}] ${summarizeEvent(event)}`,
					);
				} catch {
					console.log(`  [RAW] ${stdoutBuf.trim().slice(0, 200)}`);
				}
			}

			if (stderrBuf.trim()) {
				console.log(`\n  STDERR:\n${indent(stderrBuf.trim(), 4)}`);
			}

			console.log(`\n  Exit code: ${code}`);
			console.log(`  Total events: ${events.length}`);

			// Print event type distribution
			const typeCounts: Record<string, number> = {};
			for (const e of events) {
				const t = (e as { type?: string }).type || "unknown";
				typeCounts[t] = (typeCounts[t] || 0) + 1;
			}
			console.log(
				`  Event types: ${JSON.stringify(typeCounts, null, 2)}`,
			);

			resolve({ events, stderr: stderrBuf, exitCode: code });
		});

		// Close stdin immediately
		proc.stdin.end();
	});
}

function summarizeEvent(event: Record<string, unknown>): string {
	const type = event.type as string;

	switch (type) {
		case "system":
			return `session=${event.session_id || "?"}, tools=${Array.isArray(event.tools) ? event.tools.length : "?"}`;
		case "assistant": {
			const msg = event.message as Record<string, unknown> | undefined;
			if (msg?.content) {
				const content = msg.content as Array<Record<string, unknown>>;
				const types = content.map((c) => c.type).join(", ");
				const textBlock = content.find((c) => c.type === "text");
				const text = textBlock
					? (textBlock.text as string).slice(0, 80)
					: "";
				return `blocks=[${types}] ${text}`;
			}
			return JSON.stringify(event).slice(0, 120);
		}
		case "content_block_start":
			return `index=${event.index} block_type=${(event.content_block as Record<string, unknown>)?.type || "?"}`;
		case "content_block_delta":
			return `index=${event.index} delta=${JSON.stringify(event.delta).slice(0, 80)}`;
		case "content_block_stop":
			return `index=${event.index}`;
		case "result":
			return `session=${event.session_id || "?"}, cost=$${event.total_cost_usd || "?"}, duration=${event.duration_ms || "?"}ms`;
		default:
			return JSON.stringify(event).slice(0, 120);
	}
}

function indent(text: string, spaces: number): string {
	const pad = " ".repeat(spaces);
	return text
		.split("\n")
		.map((l) => pad + l)
		.join("\n");
}

async function main() {
	console.log("Stream-JSON Test Suite");
	console.log(`Claude CLI: ${CLAUDE_PATH}`);
	console.log(`Prompt: "${PROMPT}"`);

	for (const test of tests) {
		const result = await runTest(test.name, test.args);

		// If first test succeeds, dump full event JSON for inspection
		if (result.events.length > 0 && result.exitCode === 0) {
			console.log("\n  --- Full event dump ---");
			for (const event of result.events) {
				console.log(`  ${JSON.stringify(event)}`);
			}
		}

		// If it failed, still try the next test
		if (result.exitCode !== 0) {
			console.log(`\n  ⚠️  Test failed with exit code ${result.exitCode}`);
		}
	}

	console.log("\n" + "=".repeat(60));
	console.log("All tests complete.");
}

main().catch(console.error);

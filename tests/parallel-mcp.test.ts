import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BACKEND_DEFS } from "../extensions/backends/registry.js";
import { searchParallelMCP } from "../extensions/backends/parallel-mcp.js";
import { config, refreshConfig } from "../extensions/config.js";
import searchHub from "../extensions/search-hub.js";

vi.mock("../extensions/backends/openai-codex.js", () => ({
	searchOpenAICodex: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", async () => {
	const { Type } = await import("typebox");
	return {
		StringEnum: (values: string[]) => Type.Union(values.map(value => Type.Literal(value))),
	};
}, { virtual: true });

describe("Parallel Search MCP backend", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;
	let toolResult: Record<string, unknown>;
	let requestPayloads: Record<string, unknown>[];
	let requestUrls: string[];
	let requestHeaders: Headers[];

	beforeEach(() => {
		toolResult = {
			content: [{ type: "text", text: "Search completed." }],
			structuredContent: {
				results: [
					{ title: "First", url: "https://example.com/1", excerpts: ["First excerpt", "Second excerpt"] },
					{ title: "Second", url: "https://example.com/2", excerpts: ["Another excerpt"] },
				],
			},
		};
		requestPayloads = [];
		requestUrls = [];
		requestHeaders = [];
		fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const method = init?.method ?? (input instanceof Request ? input.method : undefined);
			requestUrls.push(input instanceof Request ? input.url : String(input));
			requestHeaders.push(new Headers(input instanceof Request ? input.headers : init?.headers));
			if (method === "DELETE") return new Response(null, { status: 200 });
			const body = typeof init?.body === "string" ? init.body : input instanceof Request ? await input.text() : "{}";
			const request = JSON.parse(body) as Record<string, unknown>;
			requestPayloads.push(request);
			if (request.method === "initialize") {
				const params = request.params as Record<string, unknown>;
				return Response.json({
					jsonrpc: "2.0",
					id: request.id,
					result: {
						protocolVersion: params.protocolVersion,
						capabilities: { tools: {} },
						serverInfo: { name: "Parallel Search MCP", version: "1.0.0" },
					},
				}, { headers: { "Mcp-Session-Id": "test-session" } });
			}
			if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
			if (request.method === "tools/call") {
				return Response.json({ jsonrpc: "2.0", id: request.id, result: toolResult });
			}
			throw new Error(`Unexpected MCP request: ${String(request.method)} ${String(input)}`);
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("is registered as a keyless backend and maps structured results", async () => {
		const result = await searchParallelMCP("pi search extension", 1);
		const call = requestPayloads.find(request => request.method === "tools/call");
		const params = call?.params as Record<string, unknown>;
		const args = params?.arguments as Record<string, unknown>;
		const callIndex = requestPayloads.findIndex(request => request.method === "tools/call");
		const callHeaders = requestHeaders[callIndex];

		expect(BACKEND_DEFS.parallel_mcp.needsKey).toBe(false);
		expect(BACKEND_DEFS.parallel_mcp.setupLabel).toContain("no API key");
		expect(result.results).toEqual([
			{ title: "First", url: "https://example.com/1", snippet: "First excerpt\nSecond excerpt" },
		]);
		expect(params?.name).toBe("web_search");
		expect(args).toMatchObject({ objective: "pi search extension", search_queries: ["pi search extension"] });
		expect(requestUrls[0]).toBe("https://search.parallel.ai/mcp");
		expect(callIndex).toBeGreaterThanOrEqual(0);
		expect(requestHeaders.every(headers => headers.get("user-agent") === "pi-search-hub/2.8.0")).toBe(true);
		expect(callHeaders?.get("content-type")).toBe("application/json");
		expect(callHeaders?.get("accept")).toBe("application/json, text/event-stream");
		expect(callHeaders?.get("mcp-session-id")).toBe("test-session");
		expect(requestHeaders.every(headers => !headers.has("authorization"))).toBe(true);
	});

	it("parses JSON text results when structured content is absent", async () => {
		toolResult = {
			content: [{
				type: "text",
				text: JSON.stringify({ results: [{ title: "Text result", url: "https://example.com/text", snippet: "From text" }] }),
			}],
		};

		const result = await searchParallelMCP("text result", 10);

		expect(result.results).toEqual([
			{ title: "Text result", url: "https://example.com/text", snippet: "From text" },
		]);
	});

	it("surfaces MCP tool errors", async () => {
		toolResult = { isError: true, content: [{ type: "text", text: "Search is rate limited." }] };

		await expect(searchParallelMCP("rate limit", 10)).rejects.toThrow("Search is rate limited.");
	});

	it("returns useful results through the configured web_search entrypoint", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-search-hub-entrypoint-"));
		const homeDir = join(tempRoot, "home");
		const projectDir = join(tempRoot, "project");
		mkdirSync(homeDir, { recursive: true });
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "search.json"), JSON.stringify({
			defaultBackend: "parallel_mcp",
			backends: { parallel_mcp: { enabled: true } },
		}));
		vi.stubEnv("HOME", homeDir);
		vi.stubEnv("USERPROFILE", homeDir);

		const registeredTools = new Map<string, unknown>();
		searchHub({
			registerTool: (tool: { name: string }) => registeredTools.set(tool.name, tool),
			registerCommand: vi.fn(),
			on: vi.fn(),
		} as never);

		try {
			const webSearchTool = registeredTools.get("web_search") as {
				execute: (...args: any[]) => Promise<{
					content: Array<{ type: string; text?: string }>;
					details: { backend: string; resultCount: number };
				}>;
			};
			const result = await webSearchTool.execute("entrypoint-test", {
				query: "configured Parallel entrypoint",
				numResults: 1,
				backend: "parallel_mcp",
			}, undefined, undefined, {
				cwd: projectDir,
				ui: { setStatus: vi.fn() },
			});

			expect(result.details).toMatchObject({ backend: "parallel_mcp", resultCount: 1 });
			expect(result.content[0].text).toContain("https://example.com/1");
			expect(requestPayloads.some(request => request.method === "tools/call")).toBe(true);
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	it("keeps DuckDuckGo first when Parallel MCP is enabled", () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-search-hub-parallel-"));
		const homeDir = join(tempRoot, "home");
		const projectDir = join(tempRoot, "project");
		mkdirSync(homeDir, { recursive: true });
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "search.json"), JSON.stringify({
			backends: {
				parallel_mcp: { enabled: true },
				duckduckgo: { enabled: true },
			},
		}));
		vi.stubEnv("HOME", homeDir);
		vi.stubEnv("USERPROFILE", homeDir);

		try {
			const activeBackends = refreshConfig(projectDir, true);
			expect(activeBackends[0]).toBe("duckduckgo");
			expect(activeBackends).toContain("parallel_mcp");
			expect(config.defaultBackend).toBe("duckduckgo");
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});
});

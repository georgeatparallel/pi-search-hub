import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { SearchResult } from "../types.js";
import { timeoutSignal } from "../utils.js";

const PARALLEL_MCP_ENDPOINT = new URL("https://search.parallel.ai/mcp");
const SEARCH_SESSION_ID = randomUUID();
const REQUEST_TIMEOUT_MS = 30_000;
const PARALLEL_CLIENT_NAME = "pi-search-hub";
const PARALLEL_CLIENT_VERSION = "2.8.0";
const PARALLEL_USER_AGENT = `${PARALLEL_CLIENT_NAME}/${PARALLEL_CLIENT_VERSION}`;

type SearchRecord = Record<string, unknown>;
type ParallelToolResult = {
	content: Array<{ type: string; text?: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
};

function isRecord(value: unknown): value is SearchRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getTextContent(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter(item => item.type === "text")
		.map(item => item.text ?? "")
		.join("\n");
}

function parseToolResult(value: unknown): ParallelToolResult {
	if (!isRecord(value) || !Array.isArray(value.content)) {
		throw new Error("Parallel Search MCP returned an invalid tool response.");
	}

	const content = value.content.flatMap(item => {
		if (!isRecord(item) || typeof item.type !== "string") return [];
		return [{ type: item.type, ...(typeof item.text === "string" ? { text: item.text } : {}) }];
	});
	return {
		content,
		...(isRecord(value.structuredContent) ? { structuredContent: value.structuredContent } : {}),
		...(value.isError === true ? { isError: true } : {}),
	};
}

function getRawResults(result: {
	structuredContent?: Record<string, unknown>;
	content: Array<{ type: string; text?: string }>;
}): unknown[] {
	const structuredResults = result.structuredContent?.results;
	if (Array.isArray(structuredResults)) return structuredResults;

	const text = getTextContent(result.content);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("Parallel Search MCP returned an invalid search response.");
	}

	if (Array.isArray(parsed)) return parsed;
	if (isRecord(parsed) && Array.isArray(parsed.results)) return parsed.results;
	throw new Error("Parallel Search MCP returned an invalid search response.");
}

function normalizeResults(result: {
	structuredContent?: Record<string, unknown>;
	content: Array<{ type: string; text?: string }>;
}, numResults: number): SearchResult[] {
	return getRawResults(result).flatMap(value => {
		if (!isRecord(value) || typeof value.url !== "string") return [];

		let url: URL;
		try {
			url = new URL(value.url);
		} catch {
			return [];
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") return [];

		const excerpts = Array.isArray(value.excerpts)
			? value.excerpts.filter((excerpt): excerpt is string => typeof excerpt === "string")
			: [];
		const snippet = typeof value.snippet === "string" && value.snippet.trim()
			? value.snippet
			: typeof value.description === "string" && value.description.trim()
				? value.description
				: excerpts.join("\n");
		return [{
			title: typeof value.title === "string" && value.title.trim() ? value.title : value.url,
			url: value.url,
			...(snippet ? { snippet } : {}),
		}];
	}).slice(0, Math.max(1, Math.min(Math.floor(numResults), 20)));
}

export async function searchParallelMCP(
	query: string,
	numResults: number,
	signal?: AbortSignal,
): Promise<{ results: SearchResult[] }> {
	const requestSignal = timeoutSignal(signal, REQUEST_TIMEOUT_MS);
	const client = new Client({ name: PARALLEL_CLIENT_NAME, version: PARALLEL_CLIENT_VERSION });
	const transport = new StreamableHTTPClientTransport(PARALLEL_MCP_ENDPOINT, {
		requestInit: {
			// Identify the project for aggregate free-MCP measurement; keep this project-wide, never per-user or per-installation.
			headers: { "User-Agent": PARALLEL_USER_AGENT },
			signal: requestSignal,
		},
	});

	try {
		await client.connect(transport, { signal: requestSignal });
		const result = parseToolResult(await client.callTool({
			name: "web_search",
			arguments: {
				objective: query,
				search_queries: [query],
				session_id: SEARCH_SESSION_ID,
			},
		}, undefined, { signal: requestSignal }));

		if (result.isError) {
			throw new Error(getTextContent(result.content) || "Parallel Search MCP returned an error.");
		}

		return { results: normalizeResults(result, numResults) };
	} catch (error) {
		if (signal?.aborted) throw error;
		const message = error instanceof Error ? error.message : "Unknown error";
		throw new Error(`Parallel Search MCP failed: ${message}`, { cause: error });
	} finally {
		await client.close().catch(() => undefined);
	}
}

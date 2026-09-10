import { spawn } from "node:child_process";
import type { Duplex, Readable, Writable } from "node:stream";

const ALLOWED_TOOLS = new Set([
  "browser_navigate",
  "browser_get_state",
  "browser_evaluate",
  "browser_click",
  "browser_wait_for_stable_dom",
  "browser_wait_for_network_idle",
  "browser_wait",
  "browser_wait_for_url",
  "browser_scroll_to_text",
]);

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: JsonRpcError;
}

interface ToolContent {
  type: string;
  text?: string;
}

interface ToolResult {
  content?: ToolContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

interface Transport {
  readable: Readable;
  writable: Writable;
  close(): Promise<void>;
}

export interface AgentycClient {
  call<T = unknown>(tool: string, args: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

export interface CreateAgentycClientOptions {
  cdpUrl: string;
  transport?: Duplex;
  executable?: string;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

const SECRET_KEY = /password|cookie|token|secret/i;

const sanitizedValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sanitizedValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SECRET_KEY.test(key) ? "[REDACTED]" : sanitizedValue(entry),
      ]),
    );
  }
  return value;
};

const sanitizedText = (value: string): string =>
  value.replace(
    /(["']?[\w-]*(?:password|cookie|token|secret)[\w-]*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
    "$1[REDACTED]",
  );

const rpcError = (error: JsonRpcError): Error => {
  const safeData = error.data === undefined ? "" : ` ${JSON.stringify(sanitizedValue(error.data))}`;
  return new Error(sanitizedText(`agentyc JSON-RPC ${error.code}: ${error.message}${safeData}`));
};

const toolText = (result: ToolResult): string =>
  (result.content ?? [])
    .filter((content) => content.type === "text" && typeof content.text === "string")
    .map((content) => content.text)
    .join("\n");

const decodeToolResult = <T>(value: unknown): T => {
  const result = (value ?? {}) as ToolResult;
  const text = toolText(result);
  if (result.isError === true) {
    throw new Error(sanitizedText(text || "agentyc tool call failed"));
  }
  if (result.structuredContent !== undefined) return result.structuredContent as T;
  if (text === "") return value as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
};

class StdioAgentycClient implements AgentycClient {
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private input = "";
  private closed = false;

  constructor(private readonly transport: Transport) {
    transport.readable.setEncoding("utf8");
    transport.readable.on("data", (chunk: string) => this.onData(chunk));
    transport.readable.on("error", (error: Error) => this.rejectAll(error));
    transport.readable.on("end", () => this.rejectAll(new Error("agentyc transport ended")));
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "corridor-avaal-ui-import", version: "1.0.0" },
    });
    this.write({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }

  async call<T>(tool: string, args: Record<string, unknown>): Promise<T> {
    if (!ALLOWED_TOOLS.has(tool)) {
      throw new Error(`agentyc tool ${tool} is not allowed by the UI extraction client`);
    }
    const result = await this.request("tools/call", { name: tool, arguments: args });
    return decodeToolResult<T>(result);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error("agentyc client closed"));
    await this.transport.close();
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("agentyc client is closed"));
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.write({ jsonrpc: "2.0", id, method, params });
    return result;
  }

  private write(message: Record<string, unknown>): void {
    this.transport.writable.write(`${JSON.stringify(message)}\n`);
  }

  private onData(chunk: string): void {
    this.input += chunk;
    const lines = this.input.split("\n");
    this.input = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let response: JsonRpcResponse;
      try {
        response = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (typeof response.id !== "number") continue;
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      if (response.error) pending.reject(rpcError(response.error));
      else pending.resolve(response.result);
    }
  }

  private rejectAll(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}

const injectedTransport = (transport: Duplex): Transport => ({
  readable: transport,
  writable: transport,
  close: async () => {
    transport.destroy();
  },
});

const spawnedTransport = (options: CreateAgentycClientOptions): Transport => {
  const child = spawn(
    options.executable ?? "agentyc",
    [
      "mcp",
      "--cdp-url",
      options.cdpUrl,
      "--shared-browser-focus-policy",
      "activate",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stderr.resume();
  return {
    readable: child.stdout,
    writable: child.stdin,
    close: async () => {
      if (child.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      });
    },
  };
};

export const createAgentycClient = async (
  options: CreateAgentycClientOptions,
): Promise<AgentycClient> => {
  if (!options.cdpUrl.trim()) throw new Error("cdpUrl must not be empty");
  const transport = options.transport
    ? injectedTransport(options.transport)
    : spawnedTransport(options);
  const client = new StdioAgentycClient(transport);
  try {
    await client.initialize();
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
};

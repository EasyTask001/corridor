import { Duplex } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { createAgentycClient } from "./agentyc-client";

class FakeTransport extends Duplex {
  readonly messages: Array<Record<string, unknown>> = [];
  private pending = "";

  override _read(): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.pending += chunk.toString("utf8");
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) this.messages.push(JSON.parse(line) as Record<string, unknown>);
    }
    callback();
  }

  respond(message: Record<string, unknown>): void {
    this.push(`${JSON.stringify(message)}\n`);
  }
}

const initialize = async () => {
  const transport = new FakeTransport();
  const pendingClient = createAgentycClient({
    cdpUrl: "ws://127.0.0.1:9224/devtools/browser/test",
    transport,
  });
  await vi.waitFor(() => expect(transport.messages).toHaveLength(1));
  const request = transport.messages[0]!;
  transport.respond({ jsonrpc: "2.0", id: request.id, result: { capabilities: {} } });
  const client = await pendingClient;
  return { client, request, transport };
};

describe("agentyc MCP client", () => {
  it("initializes once using the required MCP protocol version", async () => {
    const { client, request, transport } = await initialize();

    expect(request).toMatchObject({
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    expect(transport.messages[1]).toMatchObject({
      method: "notifications/initialized",
    });
    await client.close();
  });

  it("matches out-of-order tool responses to their request IDs", async () => {
    const { client, transport } = await initialize();
    const first = client.call<{ value: string }>("browser_get_state", {});
    const second = client.call<{ value: string }>("browser_evaluate", {
      code: "(function(){ return {value: 'second'}; })()",
    });
    await vi.waitFor(() => expect(transport.messages).toHaveLength(4));
    const firstRequest = transport.messages[2]!;
    const secondRequest = transport.messages[3]!;

    transport.respond({
      jsonrpc: "2.0",
      id: secondRequest.id,
      result: { content: [{ type: "text", text: '{"value":"second"}' }], isError: false },
    });
    transport.respond({
      jsonrpc: "2.0",
      id: firstRequest.id,
      result: { content: [{ type: "text", text: '{"value":"first"}' }], isError: false },
    });

    await expect(first).resolves.toEqual({ value: "first" });
    await expect(second).resolves.toEqual({ value: "second" });
    await client.close();
  });

  it("rejects JSON-RPC and tool errors without leaking secrets", async () => {
    const { client, transport } = await initialize();
    const rpcFailure = client.call("browser_navigate", { url: "https://example.test" });
    await vi.waitFor(() => expect(transport.messages).toHaveLength(3));
    const rpcRequest = transport.messages[2]!;
    transport.respond({
      jsonrpc: "2.0",
      id: rpcRequest.id,
      error: {
        code: -32_000,
        message: "Rejected",
        data: { password: "do-not-leak", nested: { accessToken: "also-secret" } },
      },
    });

    const toolFailure = client.call("browser_evaluate", { code: "(function(){return 1;})()" });
    await vi.waitFor(() => expect(transport.messages).toHaveLength(4));
    const toolRequest = transport.messages[3]!;
    transport.respond({
      jsonrpc: "2.0",
      id: toolRequest.id,
      result: {
        content: [
          { type: "text", text: 'Failed with cookie="session-value" and secret: hidden' },
        ],
        isError: true,
      },
    });

    await expect(rpcFailure).rejects.toThrow(/Rejected/);
    await expect(rpcFailure).rejects.not.toThrow(/do-not-leak|also-secret/);
    await expect(toolFailure).rejects.toThrow(/Failed/);
    await expect(toolFailure).rejects.not.toThrow(/session-value|hidden/);
    await client.close();
  });

  it("refuses tools outside the read-only traversal allowlist", async () => {
    const { client } = await initialize();

    await expect(client.call("browser_get_cookies", {})).rejects.toThrow(/not allowed/i);
    await client.close();
  });
});

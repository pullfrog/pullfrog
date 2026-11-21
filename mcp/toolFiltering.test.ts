import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type } from "arktype";
import { FastMCP } from "fastmcp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execute, tool } from "./shared.ts";

function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") return reject(new Error("bad address"));
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

async function connectMcpClient(url: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: "test-client", version: "0.0.1" });
  // @ts-expect-error — exactOptionalPropertyTypes mismatch: SDK Transport.sessionId?: string vs StreamableHTTPClientTransport getter returning string | undefined
  await client.connect(transport);
  return client;
}

function mockTool(name: string, description: string) {
  return tool({
    name,
    description,
    parameters: type({ value: "string" }),
    execute: execute(async () => ({ ok: true })),
  });
}

describe("MCP server tool registration - integration", () => {
  let server: FastMCP;
  let serverUrl: string;
  const clients: Client[] = [];

  beforeAll(async () => {
    const port = await getRandomPort();
    serverUrl = `http://127.0.0.1:${port}/mcp`;

    server = new FastMCP({ name: "test-server", version: "0.0.1" });
    server.addTool(mockTool("shell", "run shell commands"));
    server.addTool(mockTool("git", "run git commands"));
    server.addTool(mockTool("set_output", "set output"));
    server.addTool(mockTool("select_mode", "select a mode"));
    server.addTool(mockTool("push_branch", "push branch"));
    server.addTool(mockTool("create_pull_request", "create PR"));

    await server.start({
      transportType: "httpStream",
      httpStream: { port, host: "127.0.0.1", endpoint: "/mcp" },
    });
  });

  afterAll(async () => {
    for (const client of clients) {
      try {
        await client.close();
      } catch {
        // best-effort cleanup
      }
    }
    await server.stop();
  });

  it("server exposes all registered tools", async () => {
    const client = await connectMcpClient(serverUrl);
    clients.push(client);
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("select_mode");
    expect(names).toContain("push_branch");
    expect(names).toContain("create_pull_request");
    expect(names).toContain("shell");
    expect(names).toContain("git");
    expect(names).toContain("set_output");
    expect(names.length).toBe(6);
  });
});

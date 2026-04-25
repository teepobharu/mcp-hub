import { describe, expect, it, vi } from "vitest";
import EventEmitter from "events";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MCPServerEndpoint } from "../src/mcp/server.js";

function createHubWithConnection(connection) {
  const hub = new EventEmitter();
  hub.connections = new Map([[connection.name, connection]]);
  hub.rawRequest = vi.fn();
  hub.getConnection = (name) => hub.connections.get(name);
  return hub;
}

describe("MCPServerEndpoint tool policy", () => {
  it("filters disallowed tools from registered capabilities", () => {
    const connection = {
      name: "sem",
      status: "connected",
      disabled: false,
      config: {
        removed_tools: ["sem_log"],
      },
      tools: [{ name: "sem_log" }, { name: "sem_entities" }],
      resources: [],
      resourceTemplates: [],
      prompts: [],
      serverInfo: null,
    };

    const hub = createHubWithConnection(connection);
    const endpoint = new MCPServerEndpoint(hub);

    const keys = [...endpoint.registeredCapabilities.tools.keys()];
    expect(keys).toEqual(["sem__sem_entities"]);
  });

  it("blocks tools/call for tools denied by policy", async () => {
    const connection = {
      name: "sem",
      status: "connected",
      disabled: false,
      config: {
        removed_tools: ["sem_log"],
      },
      tools: [{ name: "sem_log" }],
      resources: [],
      resourceTemplates: [],
      prompts: [],
      serverInfo: null,
    };

    const hub = createHubWithConnection(connection);
    const endpoint = new MCPServerEndpoint(hub);

    endpoint.registeredCapabilities.tools.set("sem__sem_log", {
      serverName: "sem",
      originalName: "sem_log",
      definition: { name: "sem__sem_log" },
    });

    const handlers = new Map();
    endpoint.setupRequestHandlers({
      setRequestHandler(schema, handler) {
        handlers.set(schema, handler);
      },
    });

    const callHandler = handlers.get(CallToolRequestSchema);
    await expect(
      callHandler({ params: { name: "sem__sem_log", arguments: {} } }),
    ).rejects.toThrow("Tool is disabled by policy");
    expect(hub.rawRequest).not.toHaveBeenCalled();
  });
});

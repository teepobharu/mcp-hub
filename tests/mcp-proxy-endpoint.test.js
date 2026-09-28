import { describe, expect, it, vi } from "vitest";
import EventEmitter from "events";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { MCPProxyEndpoint, __TEST__ } from "../src/mcp/proxy.js";

function makeHub(connections) {
  const hub = new EventEmitter();
  hub.connections = new Map(connections.map((c) => [c.name, c]));
  hub.rawRequest = vi.fn();
  hub.getConnection = (name) => hub.connections.get(name);
  hub.hubServerUrl = "http://localhost:0";
  return hub;
}

function captureHandlers(endpoint) {
  const handlers = new Map();
  endpoint.setupRequestHandlers({
    setRequestHandler(schema, handler) {
      handlers.set(schema, handler);
    },
  });
  return handlers;
}

const sampleConnection = (overrides = {}) => ({
  name: "gitlab_mr",
  status: "connected",
  disabled: false,
  config: {},
  tools: [
    {
      name: "get_merge_request",
      description: "Get details of a merge request",
      annotations: { readOnlyHint: true },
      inputSchema: { type: "object", properties: { id: { type: "number" } } },
    },
    {
      name: "list_pipelines",
      description: "List CI pipelines for a project",
      annotations: { readOnlyHint: true },
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "create_pipeline",
      description: "Trigger a new CI pipeline",
      annotations: { readOnlyHint: false },
      inputSchema: { type: "object", properties: { ref: { type: "string" } } },
    },
  ],
  serverInfo: { description: "GitLab MR + pipelines" },
  ...overrides,
});

describe("MCPProxyEndpoint meta-tools", () => {
  it("exposes exactly the documented meta-tools via tools/list", async () => {
    const endpoint = new MCPProxyEndpoint(makeHub([sampleConnection()]));
    const handlers = captureHandlers(endpoint);
    const result = await handlers.get(ListToolsRequestSchema)({});
    const names = result.tools.map((t) => t.name);
    expect(names).toEqual([
      "mcphub_list_servers",
      "mcphub_list_tools",
      "mcphub_call_tool",
    ]);
    expect(__TEST__.META_TOOLS.length).toBe(3);
  });

  it("mcphub_list_servers returns connected servers with policy-aware tool counts", async () => {
    const endpoint = new MCPProxyEndpoint(
      makeHub([
        sampleConnection({
          config: { removed_tools: ["create_pipeline"] },
        }),
        {
          name: "atlassian",
          status: "disconnected",
          disabled: true,
          config: {},
          tools: [{ name: "x" }],
          serverInfo: null,
        },
      ]),
    );
    const handlers = captureHandlers(endpoint);
    const callHandler = handlers.get(CallToolRequestSchema);

    const res = await callHandler({
      params: { name: "mcphub_list_servers", arguments: {} },
    });
    const parsed = JSON.parse(res.content[0].text);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      name: "gitlab_mr",
      status: "connected",
      tool_count: 2, // create_pipeline removed by policy
    });
  });

  it("mcphub_list_tools applies substring filter case-insensitively", async () => {
    const endpoint = new MCPProxyEndpoint(makeHub([sampleConnection()]));
    const handlers = captureHandlers(endpoint);
    const callHandler = handlers.get(CallToolRequestSchema);

    const res = await callHandler({
      params: {
        name: "mcphub_list_tools",
        arguments: { server: "gitlab_mr", filter: "PIPELINE" },
      },
    });
    const parsed = JSON.parse(res.content[0].text);

    expect(parsed.map((t) => t.name).sort()).toEqual([
      "create_pipeline",
      "list_pipelines",
    ]);
  });

  it("mcphub_list_tools default output omits inputSchema and includes readonly flag", async () => {
    const endpoint = new MCPProxyEndpoint(makeHub([sampleConnection()]));
    const handlers = captureHandlers(endpoint);
    const callHandler = handlers.get(CallToolRequestSchema);

    const res = await callHandler({
      params: { name: "mcphub_list_tools", arguments: { server: "gitlab_mr" } },
    });
    const parsed = JSON.parse(res.content[0].text);

    expect(parsed).toHaveLength(3);
    // default: no inputSchema
    expect(parsed[0]).not.toHaveProperty("inputSchema");
    // readonly flag derived from annotations
    expect(parsed.find((t) => t.name === "get_merge_request").readonly).toBe(true);
    expect(parsed.find((t) => t.name === "create_pipeline").readonly).toBe(false);
  });

  it("mcphub_list_tools include_schema=true adds inputSchema", async () => {
    const endpoint = new MCPProxyEndpoint(makeHub([sampleConnection()]));
    const handlers = captureHandlers(endpoint);
    const callHandler = handlers.get(CallToolRequestSchema);

    const res = await callHandler({
      params: {
        name: "mcphub_list_tools",
        arguments: { server: "gitlab_mr", include_schema: true },
      },
    });
    const parsed = JSON.parse(res.content[0].text);

    expect(parsed[0]).toHaveProperty("inputSchema");
  });

  it("mcphub_list_tools filter matches name only (not description)", async () => {
    const endpoint = new MCPProxyEndpoint(makeHub([sampleConnection()]));
    const handlers = captureHandlers(endpoint);
    const callHandler = handlers.get(CallToolRequestSchema);

    // "CI" appears only in descriptions, not names — should return nothing
    const res = await callHandler({
      params: { name: "mcphub_list_tools", arguments: { server: "gitlab_mr", filter: "CI" } },
    });
    expect(JSON.parse(res.content[0].text)).toHaveLength(0);
  });

  it("mcphub_list_tools filter_description matches description only", async () => {
    const endpoint = new MCPProxyEndpoint(makeHub([sampleConnection()]));
    const handlers = captureHandlers(endpoint);
    const callHandler = handlers.get(CallToolRequestSchema);

    // "CI" appears only in description of list_pipelines and create_pipeline
    const res = await callHandler({
      params: {
        name: "mcphub_list_tools",
        arguments: { server: "gitlab_mr", filter_description: "CI" },
      },
    });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.map((t) => t.name).sort()).toEqual(["create_pipeline", "list_pipelines"]);
  });

  it("mcphub_list_tools filter_any matches name OR description", async () => {
    const endpoint = new MCPProxyEndpoint(makeHub([sampleConnection()]));
    const handlers = captureHandlers(endpoint);
    const callHandler = handlers.get(CallToolRequestSchema);

    // "CI" in description + "get_merge_request" has "merge" in name and description
    const res = await callHandler({
      params: {
        name: "mcphub_list_tools",
        arguments: { server: "gitlab_mr", filter_any: "CI" },
      },
    });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.map((t) => t.name).sort()).toEqual(["create_pipeline", "list_pipelines"]);
  });

  it("mcphub_list_tools multiple filters AND together", async () => {
    const endpoint = new MCPProxyEndpoint(makeHub([sampleConnection()]));
    const handlers = captureHandlers(endpoint);
    const callHandler = handlers.get(CallToolRequestSchema);

    // filter name="pipeline" AND filter_description="Trigger" — only create_pipeline matches both
    const res = await callHandler({
      params: {
        name: "mcphub_list_tools",
        arguments: { server: "gitlab_mr", filter: "pipeline", filter_description: "Trigger" },
      },
    });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.map((t) => t.name)).toEqual(["create_pipeline"]);
  });

  it("mcphub_list_tools readonly_only=true returns only readonly tools", async () => {
    const endpoint = new MCPProxyEndpoint(makeHub([sampleConnection()]));
    const handlers = captureHandlers(endpoint);
    const callHandler = handlers.get(CallToolRequestSchema);

    const res = await callHandler({
      params: {
        name: "mcphub_list_tools",
        arguments: { server: "gitlab_mr", readonly_only: true },
      },
    });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.map((t) => t.name).sort()).toEqual(["get_merge_request", "list_pipelines"]);
    expect(parsed.every((t) => t.readonly === true)).toBe(true);
  });

  it("mcphub_list_servers returns readonly_count", async () => {
    const endpoint = new MCPProxyEndpoint(makeHub([sampleConnection()]));
    const handlers = captureHandlers(endpoint);
    const callHandler = handlers.get(CallToolRequestSchema);

    const res = await callHandler({
      params: { name: "mcphub_list_servers", arguments: {} },
    });
    const parsed = JSON.parse(res.content[0].text);

    expect(parsed[0]).toMatchObject({
      name: "gitlab_mr",
      tool_count: 3,
      readonly_count: 2,
    });
  });

  it("mcphub_list_tools returns [] for unknown server", async () => {
    const endpoint = new MCPProxyEndpoint(makeHub([sampleConnection()]));
    const handlers = captureHandlers(endpoint);
    const callHandler = handlers.get(CallToolRequestSchema);

    const res = await callHandler({
      params: { name: "mcphub_list_tools", arguments: { server: "nonexistent" } },
    });
    expect(JSON.parse(res.content[0].text)).toEqual([]);
  });

  it("mcphub_call_tool routes to rawRequest with original (non-namespaced) tool name", async () => {
    const hub = makeHub([sampleConnection()]);
    hub.rawRequest.mockResolvedValue({
      content: [{ type: "text", text: "OK" }],
    });
    const endpoint = new MCPProxyEndpoint(hub);
    const handlers = captureHandlers(endpoint);
    const callHandler = handlers.get(CallToolRequestSchema);

    const res = await callHandler({
      params: {
        name: "mcphub_call_tool",
        arguments: {
          server: "gitlab_mr",
          tool: "get_merge_request",
          arguments: { id: 123 },
        },
      },
    });

    expect(hub.rawRequest).toHaveBeenCalledTimes(1);
    const [serverName, payload] = hub.rawRequest.mock.calls[0];
    expect(serverName).toBe("gitlab_mr");
    expect(payload).toEqual({
      method: "tools/call",
      params: { name: "get_merge_request", arguments: { id: 123 } },
    });
    expect(res.content[0].text).toBe("OK");
  });

  it("mcphub_call_tool surfaces isError for unknown server (no rawRequest call)", async () => {
    const hub = makeHub([sampleConnection()]);
    const endpoint = new MCPProxyEndpoint(hub);
    const handlers = captureHandlers(endpoint);
    const callHandler = handlers.get(CallToolRequestSchema);

    const res = await callHandler({
      params: {
        name: "mcphub_call_tool",
        arguments: { server: "ghost", tool: "anything", arguments: {} },
      },
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Unknown server: ghost/);
    expect(hub.rawRequest).not.toHaveBeenCalled();
  });

  it("mcphub_call_tool blocks tools denied by policy", async () => {
    const hub = makeHub([
      sampleConnection({ config: { removed_tools: ["create_pipeline"] } }),
    ]);
    const endpoint = new MCPProxyEndpoint(hub);
    const handlers = captureHandlers(endpoint);
    const callHandler = handlers.get(CallToolRequestSchema);

    await expect(
      callHandler({
        params: {
          name: "mcphub_call_tool",
          arguments: {
            server: "gitlab_mr",
            tool: "create_pipeline",
            arguments: {},
          },
        },
      }),
    ).rejects.toThrow(/disabled by policy/);
    expect(hub.rawRequest).not.toHaveBeenCalled();
  });

  it("mcphub_call_tool wraps rawRequest errors as isError text", async () => {
    const hub = makeHub([sampleConnection()]);
    hub.rawRequest.mockRejectedValue(new Error("upstream timeout"));
    const endpoint = new MCPProxyEndpoint(hub);
    const handlers = captureHandlers(endpoint);
    const callHandler = handlers.get(CallToolRequestSchema);

    const res = await callHandler({
      params: {
        name: "mcphub_call_tool",
        arguments: {
          server: "gitlab_mr",
          tool: "get_merge_request",
          arguments: {},
        },
      },
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/upstream timeout/);
  });

  it("rejects unknown meta-tool names with MethodNotFound", async () => {
    const endpoint = new MCPProxyEndpoint(makeHub([sampleConnection()]));
    const handlers = captureHandlers(endpoint);
    const callHandler = handlers.get(CallToolRequestSchema);

    await expect(
      callHandler({ params: { name: "mcphub_bogus", arguments: {} } }),
    ).rejects.toThrow(/Unknown meta-tool: mcphub_bogus/);
  });
});

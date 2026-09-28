/**
 * MCP Hub Proxy Endpoint - Lean Meta-Tool Interface
 *
 * Sibling to MCPServerEndpoint (./server.js). Instead of exposing every tool
 * from every connected server as a flat namespaced list (which dumps tens of
 * thousands of schema tokens into the client's context up-front), this
 * endpoint exposes a fixed set of three meta-tools:
 *
 *   - mcphub_list_servers : enumerate connected servers + tool counts
 *   - mcphub_list_tools   : list tools for a single server (filterable)
 *   - mcphub_call_tool    : execute a tool on a server by (server, tool, arguments)
 *
 * The LLM discovers and dispatches on demand. Tool schemas are fetched only
 * when the LLM asks for them, keeping startup context cost ~constant.
 *
 * Routing reuses MCPHub.rawRequest, the same plumbing as the flat /mcp
 * endpoint — no new transport surface beyond Express routes.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  CallToolResultSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import logger from "../utils/logger.js";
import { isToolAllowed, filterToolsByPolicy } from "../utils/tool-policy.js";

const HUB_INTERNAL_PROXY_NAME = "mcp-hub-lean-proxy";
const MCP_REQUEST_TIMEOUT = 5 * 60 * 1000;

const META_TOOLS = [
  {
    name: "mcphub_list_servers",
    description:
      "List MCP servers managed by mcp-hub. Returns name, status, description, and tool count for each. " +
      "Call this first to discover what is available before listing or calling tools.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        include_disabled: {
          type: "boolean",
          description: "Include disabled / disconnected servers (default: false).",
          default: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mcphub_list_tools",
    description:
      "List tools exposed by ONE MCP server. Returns name + description + readonly flag by default (concise). " +
      "Filters: `filter` matches tool name only; `filter_description` matches description only; `filter_any` matches either. " +
      "Multiple filters AND together. Use `readonly_only=true` to scope to safe read-only tools. " +
      "Set `include_schema=true` only when about to call a tool to fetch its inputSchema. " +
      "Returns [] if the server is unknown or disconnected.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        server: {
          type: "string",
          description: "Server name from mcphub_list_servers (e.g. 'atlassian', 'gitlab_mr').",
        },
        filter: {
          type: "string",
          description: "Optional case-insensitive substring filter on tool name only.",
        },
        filter_description: {
          type: "string",
          description: "Optional case-insensitive substring filter on tool description only.",
        },
        filter_any: {
          type: "string",
          description: "Optional case-insensitive substring filter on tool name OR description.",
        },
        readonly_only: {
          type: "boolean",
          description: "When true, only return tools with readOnlyHint=true annotation (default: false).",
          default: false,
        },
        include_schema: {
          type: "boolean",
          description: "When true, include inputSchema per tool. Use only when about to call a tool (default: false).",
          default: false,
        },
      },
      required: ["server"],
      additionalProperties: false,
    },
  },
  {
    name: "mcphub_call_tool",
    description:
      "Execute a tool on a managed MCP server. Pass the original (non-namespaced) tool name " +
      "from mcphub_list_tools. Arguments must match that tool's inputSchema. " +
      "Returns the underlying tool's result content.",
    inputSchema: {
      type: "object",
      properties: {
        server: {
          type: "string",
          description: "Server name from mcphub_list_servers.",
        },
        tool: {
          type: "string",
          description: "Tool name as returned by mcphub_list_tools (NOT namespaced).",
        },
        arguments: {
          type: "object",
          description: "Arguments object matching the tool's inputSchema. Pass {} if no arguments.",
          additionalProperties: true,
        },
      },
      required: ["server", "tool"],
      additionalProperties: false,
    },
  },
];

function textResult(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorResult(message) {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

export class MCPProxyEndpoint {
  constructor(mcpHub) {
    this.mcpHub = mcpHub;
    this.clients = new Map(); // sessionId -> { transport, server }
  }

  getEndpointUrl() {
    return `${this.mcpHub.hubServerUrl}/mcp-lean`;
  }

  createServer() {
    const server = new Server(
      { name: HUB_INTERNAL_PROXY_NAME, version: "1.0.0" },
      { capabilities: { tools: { listChanged: false } } },
    );

    server.onerror = (err) => {
      logger.warn(`Proxy endpoint onerror: ${err.message}`);
    };

    this.setupRequestHandlers(server);
    return server;
  }

  setupRequestHandlers(server) {
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: META_TOOLS }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request?.params?.name;
      const args = request?.params?.arguments || {};

      try {
        switch (name) {
          case "mcphub_list_servers":
            return textResult(this.listServers(args));
          case "mcphub_list_tools":
            return textResult(this.listTools(args));
          case "mcphub_call_tool":
            return await this.callTool(args);
          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown meta-tool: ${name}`);
        }
      } catch (error) {
        if (error instanceof McpError) {
          throw error;
        }
        logger.debug(`Proxy meta-tool '${name}' error: ${error.message}`);
        return errorResult(error.message || String(error));
      }
    });
  }

  /**
   * Connected, non-disabled servers (excluding self-reference to /mcp endpoints).
   */
  *iterServers({ includeDisabled = false } = {}) {
    for (const connection of this.mcpHub.connections.values()) {
      if (this.isSelfReference(connection)) continue;
      if (!includeDisabled) {
        if (connection.status !== "connected" || connection.disabled) continue;
      }
      yield connection;
    }
  }

  isSelfReference(connection) {
    const name = connection?.serverInfo?.name;
    return name === HUB_INTERNAL_PROXY_NAME || name === "mcp-hub-internal-endpoint";
  }

  listServers(args = {}) {
    const includeDisabled = args.include_disabled === true;
    const out = [];
    for (const conn of this.iterServers({ includeDisabled })) {
      const allowedTools = filterToolsByPolicy(conn.config, conn.tools || []);
      const readonlyCount = allowedTools.filter((t) => t.annotations?.readOnlyHint === true).length;
      out.push({
        name: conn.name,
        status: conn.status,
        disabled: !!conn.disabled,
        description: conn.serverInfo?.description || conn.config?.description || "",
        tool_count: allowedTools.length,
        readonly_count: readonlyCount,
      });
    }
    return out;
  }

  listTools(args = {}) {
    const serverName = args.server;
    if (typeof serverName !== "string" || serverName.trim() === "") {
      throw new McpError(ErrorCode.InvalidParams, "Missing required argument: server");
    }

    const conn = this.mcpHub.getConnection
      ? this.mcpHub.getConnection(serverName)
      : this.mcpHub.connections.get(serverName);

    if (!conn || conn.status !== "connected" || conn.disabled) {
      return [];
    }

    const allowed = filterToolsByPolicy(conn.config, conn.tools || []);

    const nameFilter = typeof args.filter === "string" ? args.filter.trim().toLowerCase() : "";
    const descFilter = typeof args.filter_description === "string" ? args.filter_description.trim().toLowerCase() : "";
    const anyFilter = typeof args.filter_any === "string" ? args.filter_any.trim().toLowerCase() : "";
    const readonlyOnly = args.readonly_only === true;
    const includeSchema = args.include_schema === true;

    const filtered = allowed.filter((t) => {
      const name = (t.name || "").toLowerCase();
      const desc = (t.description || "").toLowerCase();

      if (nameFilter && !name.includes(nameFilter)) return false;
      if (descFilter && !desc.includes(descFilter)) return false;
      if (anyFilter && !name.includes(anyFilter) && !desc.includes(anyFilter)) return false;
      if (readonlyOnly && t.annotations?.readOnlyHint !== true) return false;
      return true;
    });

    return filtered.map((t) => {
      const entry = {
        name: t.name,
        description: t.description || "",
        readonly: t.annotations?.readOnlyHint === true,
      };
      if (includeSchema) {
        entry.inputSchema = t.inputSchema || { type: "object" };
      }
      return entry;
    });
  }

  async callTool(args = {}) {
    const serverName = args.server;
    const toolName = args.tool;
    const toolArgs = args.arguments || {};

    if (typeof serverName !== "string" || serverName.trim() === "") {
      throw new McpError(ErrorCode.InvalidParams, "Missing required argument: server");
    }
    if (typeof toolName !== "string" || toolName.trim() === "") {
      throw new McpError(ErrorCode.InvalidParams, "Missing required argument: tool");
    }

    const conn = this.mcpHub.getConnection
      ? this.mcpHub.getConnection(serverName)
      : this.mcpHub.connections.get(serverName);

    if (!conn) {
      return errorResult(`Unknown server: ${serverName}`);
    }
    if (conn.status !== "connected" || conn.disabled) {
      return errorResult(`Server '${serverName}' is not connected (status=${conn.status}, disabled=${!!conn.disabled})`);
    }
    if (!isToolAllowed(conn.config, toolName)) {
      throw new McpError(ErrorCode.InvalidParams, `Tool is disabled by policy: ${serverName}/${toolName}`);
    }

    try {
      const result = await this.mcpHub.rawRequest(
        serverName,
        {
          method: "tools/call",
          params: { name: toolName, arguments: toolArgs },
        },
        CallToolResultSchema,
        { timeout: MCP_REQUEST_TIMEOUT },
      );
      return result;
    } catch (error) {
      logger.debug(`Proxy call_tool '${serverName}/${toolName}' failed: ${error.message}`);
      return errorResult(error.message || String(error));
    }
  }

  async handleSSEConnection(req, res) {
    const transport = new SSEServerTransport("/messages-lean", res);
    const sessionId = transport.sessionId;
    const server = this.createServer();

    this.clients.set(sessionId, { transport, server });

    let clientInfo;
    let cleanedUp = false;
    const cleanup = async () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;

      this.clients.delete(sessionId);
      res.off("close", cleanup);
      transport.onclose = undefined;
      try {
        await server.close();
      } catch (error) {
        logger.warn(
          `Error closing proxy server for ${clientInfo?.name ?? "Unknown"}: ${error.message}`,
        );
      } finally {
        logger.info(`'${clientInfo?.name ?? "Unknown"}' client disconnected from MCP HUB (lean)`);
      }
    };

    res.on("close", cleanup);
    transport.onclose = cleanup;

    await server.connect(transport);
    server.oninitialized = () => {
      clientInfo = server.getClientVersion();
      if (clientInfo) {
        logger.info(`'${clientInfo.name}' client connected to MCP HUB (lean)`);
      }
    };
  }

  async handleMCPMessage(req, res) {
    const sessionId = req.query.sessionId;
    function sendErrorResponse(code, error) {
      res.status(code).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: error.message || "Invalid request" },
        id: null,
      });
    }

    if (!sessionId) {
      logger.warn("MCP lean message received without session ID");
      return sendErrorResponse(400, new Error("Missing sessionId parameter"));
    }

    const transportInfo = this.clients.get(sessionId);
    if (transportInfo) {
      await transportInfo.transport.handlePostMessage(req, res, req.body);
    } else {
      logger.warn(`MCP lean message for unknown session: ${sessionId}`);
      return sendErrorResponse(404, new Error(`Session not found: ${sessionId}`));
    }
  }

  getStats() {
    return {
      activeClients: this.clients.size,
      metaTools: META_TOOLS.length,
    };
  }

  async close() {
    for (const [sessionId, { server }] of this.clients) {
      try {
        await server.close();
      } catch (error) {
        logger.debug(`Error closing proxy server ${sessionId}: ${error.message}`);
      }
    }
    this.clients.clear();
    logger.info("MCP proxy endpoint closed");
  }
}

export const __TEST__ = { META_TOOLS };

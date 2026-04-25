import { beforeEach, describe, expect, it, vi } from "vitest";
import { MCPHub } from "../src/MCPHub.js";
import { ConfigManager } from "../src/utils/config.js";

vi.mock("../src/utils/config.js", () => {
  const MockConfigManager = vi.fn(() => ({
    loadConfig: vi.fn(),
    watchConfig: vi.fn(),
    getConfig: vi.fn(),
    updateConfig: vi.fn(),
    on: vi.fn(),
  }));
  return { ConfigManager: MockConfigManager };
});

vi.mock("../src/MCPConnection.js", () => {
  const MockConnection = vi.fn(() => ({}));
  return { MCPConnection: MockConnection };
});

vi.mock("../src/utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

describe("MCPHub tool policy config updates", () => {
  let mcpHub;

  beforeEach(() => {
    vi.clearAllMocks();

    const configManager = new ConfigManager();
    ConfigManager.mockReturnValue(configManager);

    mcpHub = new MCPHub("config.json");
  });

  it("updates config without reconnect for policy-only changes", async () => {
    const connection = {
      disabled: false,
      config: { command: "node", args: ["server.js"] },
    };
    mcpHub.connections.set("sem", connection);

    const disconnectSpy = vi.spyOn(mcpHub, "disconnectServer").mockResolvedValue(undefined);
    const connectSpy = vi.spyOn(mcpHub, "connectServer").mockResolvedValue(undefined);
    const stopSpy = vi.spyOn(mcpHub, "stopServer").mockResolvedValue(undefined);
    const startSpy = vi.spyOn(mcpHub, "startServer").mockResolvedValue(undefined);

    const newConfig = {
      mcpServers: {
        sem: {
          command: "node",
          args: ["server.js"],
          disabled_tools: ["sem_log"],
        },
      },
    };

    const changes = {
      added: [],
      removed: [],
      modified: ["sem"],
      details: {
        sem: {
          modifiedFields: ["disabled_tools"],
          oldValues: { disabled_tools: [] },
          newValues: { disabled_tools: ["sem_log"] },
        },
      },
    };

    await mcpHub.handleConfigUpdated(newConfig, changes);

    expect(connection.config).toEqual(newConfig.mcpServers.sem);
    expect(disconnectSpy).not.toHaveBeenCalled();
    expect(connectSpy).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("reconnects server when non-policy env changes", async () => {
    const connection = {
      disabled: false,
      config: { command: "node", args: ["server.js"], env: { PATH: "foo" } },
    };
    mcpHub.connections.set("sem", connection);

    const disconnectSpy = vi.spyOn(mcpHub, "disconnectServer").mockResolvedValue(undefined);
    const connectSpy = vi.spyOn(mcpHub, "connectServer").mockResolvedValue(undefined);

    const newConfig = {
      mcpServers: {
        sem: {
          command: "node",
          args: ["server.js"],
          env: { PATH: "bar" },
        },
      },
    };

    const changes = {
      added: [],
      removed: [],
      modified: ["sem"],
      details: {
        sem: {
          modifiedFields: ["env"],
          oldValues: { env: { PATH: "foo" } },
          newValues: { env: { PATH: "bar" } },
        },
      },
    };

    await mcpHub.handleConfigUpdated(newConfig, changes);

    expect(disconnectSpy).toHaveBeenCalledWith("sem");
    expect(connectSpy).toHaveBeenCalledWith("sem", newConfig.mcpServers.sem);
  });
});

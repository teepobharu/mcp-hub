import { describe, expect, it } from "vitest";
import {
  filterToolsByPolicy,
  isToolAllowed,
  isToolPolicyOnlyChange,
} from "../src/utils/tool-policy.js";

describe("tool-policy", () => {
  it("blocks tools in disabled_tools and removed_tools", () => {
    const config = {
      disabled_tools: ["foo"],
      removed_tools: ["bar"],
    };

    expect(isToolAllowed(config, "foo")).toBe(false);
    expect(isToolAllowed(config, "bar")).toBe(false);
    expect(isToolAllowed(config, "baz")).toBe(true);
  });

  it("supports enabled and denied regex from env", () => {
    const config = {
      env: {
        GITLAB_ALLOWED_TOOLS_REGEX: "^(read|write)",
        MCPHUB_DENIED_TOOLS_REGEX: "write_sensitive$",
      },
    };

    expect(isToolAllowed(config, "read_file")).toBe(true);
    expect(isToolAllowed(config, "write_sensitive")).toBe(false);
    expect(isToolAllowed(config, "search")).toBe(false);
  });

  it("filters tool definitions by policy", () => {
    const config = {
      disabled_tools: ["foo"],
    };

    const tools = [
      { name: "foo", description: "disabled" },
      { name: "bar", description: "enabled" },
      { description: "missing-name" },
    ];

    expect(filterToolsByPolicy(config, tools)).toEqual([
      { name: "bar", description: "enabled" },
      { description: "missing-name" },
    ]);
  });

  it("detects policy-only field updates", () => {
    expect(isToolPolicyOnlyChange(["disabled_tools"])).toBe(true);
    expect(isToolPolicyOnlyChange(["removed_tools", "disabled_prompts"])).toBe(true);
    expect(isToolPolicyOnlyChange(["args"])).toBe(false);
  });

  it("detects policy-only env updates", () => {
    const oldValues = {
      env: {
        FOO: "1",
        MCPHUB_ALLOWED_TOOLS_REGEX: "^sem_",
      },
    };
    const policyOnlyNewValues = {
      env: {
        FOO: "1",
        MCPHUB_ALLOWED_TOOLS_REGEX: "^sem__(?!sem_log$)",
      },
    };
    const nonPolicyNewValues = {
      env: {
        FOO: "2",
        MCPHUB_ALLOWED_TOOLS_REGEX: "^sem_",
      },
    };

    expect(isToolPolicyOnlyChange(["env"], oldValues, policyOnlyNewValues)).toBe(true);
    expect(isToolPolicyOnlyChange(["env"], oldValues, nonPolicyNewValues)).toBe(false);
    expect(isToolPolicyOnlyChange(["disabled_tools", "env"], oldValues, policyOnlyNewValues)).toBe(true);
  });
});

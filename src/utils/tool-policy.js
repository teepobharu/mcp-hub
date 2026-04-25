const TOOL_POLICY_DENIED_KEYS = [
  "MCPHUB_DENIED_TOOLS_REGEX",
  "MCPHUB_DISABLED_TOOLS_REGEX",
  "DENIED_TOOLS_REGEX",
  "GITLAB_DENIED_TOOLS_REGEX",
];

const TOOL_POLICY_DENIED_SUFFIXES = ["DENIED_TOOLS_REGEX", "DISABLED_TOOLS_REGEX"];

const TOOL_POLICY_ENABLED_KEYS = [
  "MCPHUB_ALLOWED_TOOLS_REGEX",
  "MCPHUB_ENABLED_TOOLS_REGEX",
  "ALLOWED_TOOLS_REGEX",
  "ENABLED_TOOLS_REGEX",
  "GITLAB_ALLOWED_TOOLS_REGEX",
];

const TOOL_POLICY_ENABLED_SUFFIXES = ["ALLOWED_TOOLS_REGEX", "ENABLED_TOOLS_REGEX"];

export const TOOL_POLICY_FIELDS = [
  "disabled_tools",
  "removed_tools",
  "disabled_resources",
  "disabled_resourceTemplates",
  "disabled_prompts",
];

const TOOL_POLICY_FIELD_SET = new Set(TOOL_POLICY_FIELDS);

const regexCache = new Map();

function getEnvRegex(env, preferredKeys, suffixes) {
  if (!env || typeof env !== "object") {
    return null;
  }

  for (const key of preferredKeys) {
    const value = env[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }

  const envKeys = Object.keys(env).sort();
  for (const key of envKeys) {
    for (const suffix of suffixes) {
      if (key === suffix || key.endsWith(suffix)) {
        const value = env[key];
        if (typeof value === "string" && value.trim() !== "") {
          return value.trim();
        }
      }
    }
  }

  return null;
}

function isToolPolicyEnvKey(key) {
  if (typeof key !== "string" || key === "") {
    return false;
  }

  if (TOOL_POLICY_DENIED_KEYS.includes(key) || TOOL_POLICY_ENABLED_KEYS.includes(key)) {
    return true;
  }

  return [...TOOL_POLICY_DENIED_SUFFIXES, ...TOOL_POLICY_ENABLED_SUFFIXES].some(
    (suffix) => key === suffix || key.endsWith(suffix),
  );
}

function compileRegex(pattern) {
  if (typeof pattern !== "string" || pattern.trim() === "") {
    return null;
  }

  const normalized = pattern.trim();
  if (regexCache.has(normalized)) {
    return regexCache.get(normalized);
  }

  try {
    const compiled = new RegExp(normalized);
    regexCache.set(normalized, compiled);
    return compiled;
  } catch {
    regexCache.set(normalized, null);
    return null;
  }
}

export function buildToolPolicy(serverConfig = {}) {
  const env = serverConfig?.env || {};

  const deniedPattern = getEnvRegex(
    env,
    TOOL_POLICY_DENIED_KEYS,
    TOOL_POLICY_DENIED_SUFFIXES,
  );

  const enabledPattern = getEnvRegex(
    env,
    TOOL_POLICY_ENABLED_KEYS,
    TOOL_POLICY_ENABLED_SUFFIXES,
  );

  return {
    disabledTools: new Set(Array.isArray(serverConfig?.disabled_tools) ? serverConfig.disabled_tools : []),
    removedTools: new Set(Array.isArray(serverConfig?.removed_tools) ? serverConfig.removed_tools : []),
    deniedRegex: compileRegex(deniedPattern),
    enabledRegex: compileRegex(enabledPattern),
  };
}

export function isToolAllowed(serverConfig, toolName) {
  if (typeof toolName !== "string" || toolName.trim() === "") {
    return true;
  }

  const policy = buildToolPolicy(serverConfig);
  const name = toolName.trim();

  if (policy.removedTools.has(name)) {
    return false;
  }

  if (policy.disabledTools.has(name)) {
    return false;
  }

  if (policy.enabledRegex && !policy.enabledRegex.test(name)) {
    return false;
  }

  if (policy.deniedRegex && policy.deniedRegex.test(name)) {
    return false;
  }

  return true;
}

export function filterToolsByPolicy(serverConfig, tools = []) {
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools.filter((tool) => isToolAllowed(serverConfig, tool?.name));
}

export function isToolPolicyOnlyChange(modifiedFields, oldValues = {}, newValues = {}) {
  if (!Array.isArray(modifiedFields) || modifiedFields.length === 0) {
    return false;
  }

  const hasEnv = modifiedFields.includes("env");
  const nonEnvFields = modifiedFields.filter((field) => field !== "env");

  if (!nonEnvFields.every((field) => TOOL_POLICY_FIELD_SET.has(field))) {
    return false;
  }

  if (!hasEnv) {
    return nonEnvFields.length > 0;
  }

  const oldEnv = oldValues?.env;
  const newEnv = newValues?.env;

  if (
    (oldEnv !== undefined && (oldEnv === null || typeof oldEnv !== "object"))
    || (newEnv !== undefined && (newEnv === null || typeof newEnv !== "object"))
  ) {
    return false;
  }

  const previousEnv = oldEnv && typeof oldEnv === "object" ? oldEnv : {};
  const nextEnv = newEnv && typeof newEnv === "object" ? newEnv : {};

  const changedEnvKeys = new Set([...Object.keys(previousEnv), ...Object.keys(nextEnv)]);
  const envDiffs = [];

  for (const key of changedEnvKeys) {
    if (!Object.is(previousEnv[key], nextEnv[key])) {
      envDiffs.push(key);
    }
  }

  if (envDiffs.length === 0) {
    return false;
  }

  return envDiffs.every(isToolPolicyEnvKey);
}

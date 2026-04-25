# ADR 0001: Enforce tool policy at MCP protocol boundary

- Status: Accepted
- Date: 2026-04-26

## Context

`mcp-hub` already exposed per-server policy fields such as `disabled_tools` and `removed_tools` through integrations.
However, raw MCP clients connected directly to `/mcp` could still discover and attempt disallowed tools because policy
was not enforced at capability registration and protocol call handling.

This created inconsistent behavior between integration consumers and protocol consumers (for example inspector and
CodeCompanion via direct `/mcp` access).

## Decision

Enforce tool policy in backend `mcp-hub` at two protocol-layer points:

1. Filter disallowed tools before they are registered and exposed by `/mcp tools/list`.
2. Reject disallowed tool names during `/mcp tools/call` routing.

Also treat policy-only config updates as non-reconnect updates, so policy changes apply quickly without unnecessary
server reconnect churn.

## Implementation

- Added `src/utils/tool-policy.js`:
  - resolves policy from `disabled_tools`, `removed_tools`
  - resolves allow/deny regex from env (`*_ALLOWED_TOOLS_REGEX`, `*_ENABLED_TOOLS_REGEX`, `*_DENIED_TOOLS_REGEX`, `*_DISABLED_TOOLS_REGEX`)
  - exports `isToolAllowed` and `isToolPolicyOnlyChange`
- Updated `src/mcp/server.js`:
  - filters disallowed tools during capability registration
  - blocks disallowed tool calls in request handler
- Updated `src/utils/config.js`:
  - includes tool policy fields in config diff key set
  - compares object/array fields using deep equality for stable diffing
- Updated `src/MCPHub.js`:
  - applies policy-only config changes in-place (`connection.config = serverConfig`) without reconnect

## Validation

- Added tests:
  - `tests/tool-policy.test.js`
  - `tests/mcp-server-endpoint.test.js`
  - `tests/mcp-hub-tool-policy.test.js`
  - extended `tests/config.test.js`
- Runtime check using built `dist/cli.js` and a sample config confirmed:
  - disallowed tools are absent from `/mcp tools/list`
  - disallowed `tools/call` requests are blocked

## Consequences

- Raw MCP clients and integration consumers now see consistent tool policy behavior.
- Policy changes are cheaper to apply (no reconnect) when only policy fields/env regex are updated.
- Existing API-level server capability snapshots remain unchanged by this ADR; enforcement is at MCP endpoint exposure
  and MCP request routing.

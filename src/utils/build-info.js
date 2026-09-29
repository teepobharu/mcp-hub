// Capabilities belong to the server implementation, not the build script or
// a version comparison in a client. A build without this module has no claim.
export const features = Object.freeze({
  clearAuth: true,
  leanProxy: true,
  stdioAuthCommand: true,
  stopHub: true,
  oauthRedirectStyles: ['legacy', 'compatible', 'oauth_callback'],
});

// esbuild substitutes this literal in the standalone binary. Source-mode runs
// intentionally have no git identity; serving this module never reads .git.
const embedded = typeof __MCP_HUB_BUILD_INFO__ === 'undefined'
  ? { version: process.env.VERSION || 'dev', patches: [], changelog: [] }
  : __MCP_HUB_BUILD_INFO__;

export const buildInfo = Object.freeze({ ...embedded, features });

export function getHealthBuildInfo() {
  return {
    commit: buildInfo.shortCommit || null,
    subject: buildInfo.commitSubject || null,
    dirty: buildInfo.dirty ?? null,
    builtAt: buildInfo.builtAt || null,
    patches: buildInfo.patches?.length || 0,
    features,
  };
}

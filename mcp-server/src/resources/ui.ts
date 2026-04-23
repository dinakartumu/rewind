/**
 * Register MCP Apps UI resources. Bundled HTML is inlined into the Worker
 * at build time via `scripts/inline-bundles.mjs` (which reads `web/dist/`
 * and writes `src/ui-bundles.ts`). The Worker returns the string content
 * directly from `resources/read` -- no runtime asset fetch, no Workers
 * Static Assets binding, no second round-trip.
 *
 * This sidesteps an observed issue where `env.ASSETS` was unavailable on
 * the OAuth-wrapped `apiHandler` path but available on the `defaultHandler`
 * path. Inlining makes the bundle part of the Worker source and guarantees
 * availability in every handler.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';

/** CSP extension passed to `_meta.ui.csp` on the resource. */
export type UiCspOptions = {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
};

export type RegisterUiResourceConfig = {
  /** Human-readable name shown by clients (not the URI). */
  name: string;
  /** ui:// URI the tool's `_meta.ui.resourceUri` references. */
  uri: string;
  /** The bundled HTML string, typically a UI_BUNDLES[...] lookup. */
  html: string;
  /** Optional human-readable description. */
  description?: string;
  /** Optional CSP extensions. Default locks everything down per spec. */
  csp?: UiCspOptions;
};

export function registerUiResource(
  server: McpServer,
  config: RegisterUiResourceConfig
): void {
  registerAppResource(
    server,
    config.name,
    config.uri,
    { description: config.description },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: RESOURCE_MIME_TYPE,
          text: config.html,
          ...(config.csp ? { _meta: { ui: { csp: config.csp } } } : {}),
        },
      ],
    })
  );
}

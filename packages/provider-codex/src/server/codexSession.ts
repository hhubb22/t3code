import type * as CodexSchema from "effect-codex-app-server/schema";
import { codexModelFamily } from "@t3tools/shared/model";

import packageJson from "../../../../apps/server/package.json" with { type: "json" };

export const CODEX_CLIENT_NAME = "T3 Code";

export function codexDefaultReasoningEffortOverride(model: string): "medium" | undefined {
  return codexModelFamily(model) === "gpt-6-astra" ? "medium" : undefined;
}

/**
 * App-server starts its catalog refresh before `initialize` names the client,
 * so that first fetch goes out as the plain CLI, misses tiers like Sol
 * Ultrafast, and overwrites the shared `models_cache.json`. Naming the
 * originator at spawn closes that race.
 */
export const codexAppServerEnvironment = (
  environment: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv => ({
  CODEX_INTERNAL_ORIGINATOR_OVERRIDE: CODEX_CLIENT_NAME,
  ...environment,
});

export function buildCodexInitializeParams(): CodexSchema.V1InitializeParams {
  return {
    clientInfo: {
      name: CODEX_CLIENT_NAME,
      title: CODEX_CLIENT_NAME,
      version: packageJson.version,
    },
    capabilities: {
      experimentalApi: true,
    },
  };
}

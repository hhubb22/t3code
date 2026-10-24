// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

// Kiro CLI 2.32 selects the model on session/new. "default" is T3's sentinel
// and must not be sent as a model id.
const DEFAULT_MODEL_SENTINEL = "default";

export const KIRO_AGENT_ID = "kiro";
export const KIRO_ACP_ARGS = ["acp", "--agent-engine=v3"] as const;

function commandBasename(command: string): string {
  const normalized = command.trim();
  const slash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

export function isKiroCliBasename(command: string): boolean {
  return /^kiro-cli(?:\.exe|\.cmd)?$/i.test(commandBasename(command));
}

export function isKiroAcpSettings(settings: {
  readonly agentId: string;
  readonly commandPath: string;
}): boolean {
  return settings.agentId.trim() === KIRO_AGENT_ID || isKiroCliBasename(settings.commandPath);
}

// An explicit argument list wins. Otherwise the registered agent and the
// kiro-cli binary both launch the V3 ACP engine.
export function kiroSpawnArgs(input: {
  readonly command: string;
  readonly commandArgs: ReadonlyArray<string>;
  readonly registeredAgent: boolean;
}): ReadonlyArray<string> {
  if (input.commandArgs.length > 0) return input.commandArgs;
  if (input.registeredAgent || isKiroCliBasename(input.command)) return KIRO_ACP_ARGS;
  return input.commandArgs;
}

export function canonicalKiroWorkspace(cwd: string) {
  return Effect.promise(async () => {
    try {
      return await NodeFS.promises.realpath(cwd);
    } catch {
      return cwd;
    }
  });
}

export function kiroNewSessionMeta(
  modelId: string | undefined,
): { readonly kiro: { readonly modelId: string } } | undefined {
  const model = modelId?.trim() ?? "";
  if (model.length === 0 || model === DEFAULT_MODEL_SENTINEL) return undefined;
  return { kiro: { modelId: model } };
}

// Steer is rejected by the CLI adapter. In-session model changes and thread
// fork are advertised by some initialize payloads but were not part of the
// recorded client behavior, so they stay off.
export const kiroCapabilityOverrides = {
  sessions: {
    supportsModelSwitchInSession: false,
  },
  threads: {
    canForkThread: false,
    canForkFromTurn: false,
  },
  turns: {
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
  },
} as const;

export interface KiroSessionListPage {
  readonly sessions: ReadonlyArray<{
    readonly sessionId: string;
    readonly cwd: string;
  }>;
  readonly nextCursor?: string | null;
}

const sessionMissing = new EffectAcpErrors.AcpRequestError({
  code: -32002,
  method: "session/list",
  errorMessage: "Kiro session was not found for this workspace.",
});

const sessionWorkspaceMismatch = new EffectAcpErrors.AcpRequestError({
  code: -32002,
  method: "session/list",
  errorMessage: "Kiro session workspace does not match this thread.",
});

const sessionListCycled = new EffectAcpErrors.AcpRequestError({
  code: -32603,
  method: "session/list",
  errorMessage: "Kiro session list repeated a cursor.",
});

// Restore lists sessions before session/load. A missing id fails here and
// never opens a replacement session.
export const confirmKiroSessionPresent = Effect.fn("KiroAcp.confirmSessionPresent")(
  function* (input: {
    readonly sessionId: string;
    readonly cwd: string;
    readonly listSessions: (
      cursor?: string,
    ) => Effect.Effect<KiroSessionListPage, EffectAcpErrors.AcpError>;
  }) {
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const page = yield* input.listSessions(cursor);
      for (const session of page.sessions) {
        if (session.sessionId !== input.sessionId) continue;
        if (session.cwd === input.cwd) return;
        const canonical = yield* Effect.promise(async () => {
          try {
            return await NodeFS.promises.realpath(session.cwd);
          } catch {
            return undefined;
          }
        });
        if (canonical === input.cwd) return;
        return yield* sessionWorkspaceMismatch;
      }
      const next = page.nextCursor;
      if (next == null || next === "") return yield* sessionMissing;
      if (seenCursors.has(next)) return yield* sessionListCycled;
      seenCursors.add(next);
      cursor = next;
    }
  },
);

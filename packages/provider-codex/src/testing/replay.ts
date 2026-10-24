import type * as CodexError from "effect-codex-app-server/errors";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  CODEX_DRIVER_KIND,
  CodexAppServerClientFactory,
} from "../server.ts";

export function withCodexReplayChildMetadata(
  client: CodexClient.CodexAppServerClient["Service"],
  transcript: CodexReplay.CodexAppServerReplayTranscript,
  readMetadata: (
    threadId: string,
    method: "thread/read" | "thread/resume",
  ) => Effect.Effect<unknown, CodexError.CodexAppServerError> = (threadId) =>
    Effect.succeed({ thread: { id: threadId }, model: null }),
): CodexClient.CodexAppServerClient["Service"] {
  const childThreadIds = new Set(
    transcript.entries.flatMap((entry) => {
      if (entry.type !== "emit_inbound" || !Predicate.isObject(entry.frame)) return [];
      const params = entry.frame.params;
      if (!Predicate.isObject(params) || !Predicate.isObject(params.item)) return [];
      const item = params.item;
      if (item.type === "subAgentActivity" && typeof item.agentThreadId === "string") {
        return [item.agentThreadId];
      }
      return item.type === "collabAgentToolCall" && Array.isArray(item.receiverThreadIds)
        ? item.receiverThreadIds.filter(Predicate.isString)
        : [];
    }),
  );
  return {
    ...client,
    raw: {
      ...client.raw,
      request: (method, params) =>
        (method === "thread/read" || method === "thread/resume") &&
        Predicate.isObject(params) &&
        (method === "thread/read" ? params.includeTurns === false : params.excludeTurns === true) &&
        typeof params.threadId === "string" &&
        childThreadIds.has(params.threadId)
          ? readMetadata(params.threadId, method)
          : client.raw.request(method, params),
    },
  };
}

/** Codex app-server client backed by a recorded transcript instead of a live process. */
export function layerCodexReplayClientFactory(input: {
  readonly transcript: CodexReplay.CodexAppServerReplayTranscript;
  readonly driver?: CodexReplay.CodexAppServerReplayDriver;
}): Layer.Layer<CodexAppServerClientFactory> {
  const layerReplay =
    input.driver === undefined
      ? CodexReplay.layerReplay(input.transcript)
      : CodexReplay.layerReplayWithDriver(input.driver);
  return Layer.succeed(CodexAppServerClientFactory, {
    open: (openInput) =>
      Effect.gen(function* () {
        const context = yield* Layer.build(layerReplay).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: CODEX_DRIVER_KIND,
                providerSessionId: openInput.providerSessionId,
                cause,
              }),
          ),
        );
        return yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
          Effect.map((client) => withCodexReplayChildMetadata(client, input.transcript)),
          Effect.provide(context),
        );
      }),
  });
}

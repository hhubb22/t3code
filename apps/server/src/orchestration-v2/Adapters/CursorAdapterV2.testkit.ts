import * as HostProcess from "@t3tools/shared/HostProcess";
import type { ProviderReplayTranscript } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProviderAdapterDriverCreateError } from "@t3tools/provider-core/server/adapterDriver";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";
import { CursorAdapterV2Driver } from "@t3tools/provider-cursor/server";
import * as CursorAgentSdk from "@t3tools/provider-cursor/server/CursorAgentSdk";
import {
  CURSOR_DEFAULT_INSTANCE_ID,
  CURSOR_DRIVER_KIND,
  decodeCursorAgentSdkReplayTranscript,
  layerCursorAgentSdkReplay,
  CursorAgentSdkReplayError,
  CursorReplayTranscriptDecodeError,
  type CursorAgentSdkReplayTranscript,
} from "@t3tools/provider-cursor/testing/replay";

export * from "@t3tools/provider-cursor/testing/replay";

export const CursorOrchestratorReplayHarnessError = Schema.Union([
  CursorAgentSdkReplayError,
  ProviderAdapterDriverCreateError,
]);
export type CursorOrchestratorReplayHarnessError = typeof CursorOrchestratorReplayHarnessError.Type;

function metadataFromTranscript(transcript: ProviderReplayTranscript): {
  readonly provider?: string;
  readonly protocol?: string;
  readonly scenario?: string;
} {
  return {
    provider: transcript.provider,
    protocol: transcript.protocol,
    scenario: transcript.scenario,
  };
}

export function layer(
  transcript: CursorAgentSdkReplayTranscript,
  options?: {
    readonly runner?: CursorAgentSdk.CursorAgentSdkRunner["Service"];
    readonly assertCompleteOnFinalize?: boolean;
  },
) {
  // Skill discovery also scans user roots under HOME; an empty HOME keeps
  // replays from picking up the host's own skills.
  const layerHostEnvironment = Layer.effect(
    HostProcess.Environment,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-replay-home-" });
      return { HOME: home };
    }).pipe(Effect.orDie),
  ).pipe(Layer.provide(NodeServices.layer));
  return ProviderAdapterRegistry.layerFromDrivers({
    drivers: [CursorAdapterV2Driver],
    configMap: {
      [CURSOR_DEFAULT_INSTANCE_ID]: {
        driver: CURSOR_DRIVER_KIND,
      },
    },
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        layerCursorAgentSdkReplay(transcript, options),
        TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
        layerHostEnvironment,
        NodeServices.layer,
        IdAllocator.layer,
      ),
    ),
  );
}

export const CursorOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  CursorAgentSdkReplayTranscript,
  CursorOrchestratorReplayHarnessError
> = {
  driver: CursorAgentSdk.CURSOR_PROVIDER,
  decodeTranscript: (transcript) =>
    decodeCursorAgentSdkReplayTranscript(transcript).pipe(
      Effect.mapError(
        (cause) =>
          new CursorReplayTranscriptDecodeError({
            ...metadataFromTranscript(transcript),
            cause,
          }),
      ),
    ),
  makeProviderAdapterRegistryLayer: (transcript) => layer(transcript),
};

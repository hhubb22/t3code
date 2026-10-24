import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProviderInstanceEnvironment, ProviderReplayTranscript } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProviderAdapterDriverCreateError } from "@t3tools/provider-core/server/adapterDriver";
import * as Schema from "effect/Schema";
import { PI_PROVIDER, PiAdapterV2Driver } from "@t3tools/provider-pi/server";
import {
  decodePiRpcReplayTranscript,
  layerPiReplaySpawner,
  PiReplayTranscriptDecodeError,
  type PiRpcReplayTranscript,
} from "@t3tools/provider-pi/testing";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";

export * from "@t3tools/provider-pi/testing";

const PiOrchestratorReplayHarnessError = Schema.Union([
  PiReplayTranscriptDecodeError,
  ProviderAdapterDriverCreateError,
]);
type PiOrchestratorReplayHarnessError = typeof PiOrchestratorReplayHarnessError.Type;

export function layer<E, R>(input: {
  readonly scenario: string;
  readonly spawner: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner, E, R>;
  readonly binaryPath: string;
  readonly launchArgs: string;
  readonly environment?: ProviderInstanceEnvironment;
}) {
  return ProviderAdapterRegistry.layerFromDrivers({
    drivers: [PiAdapterV2Driver],
    configMap: {
      [PI_PROVIDER]: {
        driver: PI_PROVIDER,
        enabled: true,
        config: { binaryPath: input.binaryPath, launchArgs: input.launchArgs },
        ...(input.environment === undefined ? {} : { environment: input.environment }),
      },
    },
  }).pipe(
    Layer.provide(input.spawner),
    Layer.provide(
      Layer.mergeAll(
        TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
        NodeServices.layer,
        IdAllocator.layer,
      ),
    ),
  );
}

function metadataString(transcript: PiRpcReplayTranscript, key: string): string {
  const value = transcript.metadata?.[key];
  return typeof value === "string" ? value : "";
}

export const PiOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  PiRpcReplayTranscript,
  PiOrchestratorReplayHarnessError
> = {
  driver: PI_PROVIDER,
  decodeTranscript: (transcript: ProviderReplayTranscript) =>
    decodePiRpcReplayTranscript(transcript).pipe(
      Effect.mapError(
        (cause) =>
          new PiReplayTranscriptDecodeError({
            driver: transcript.provider,
            protocol: transcript.protocol,
            scenario: transcript.scenario,
            cause,
          }),
      ),
    ),
  makeProviderAdapterRegistryLayer: (transcript) =>
    layer({
      scenario: transcript.scenario,
      binaryPath: "pi",
      launchArgs: metadataString(transcript, "launchArgs"),
      spawner: layerPiReplaySpawner(transcript),
    }),
};

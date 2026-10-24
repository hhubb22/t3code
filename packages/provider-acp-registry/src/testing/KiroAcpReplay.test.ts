import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type ProviderReplayEntry,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import {
  ACP_REGISTRY_PROVIDER,
  makeAcpRegistryAdapterV2,
} from "@t3tools/provider-acp-registry/testing";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import { acpScopedNativeId } from "@t3tools/provider-acp/server/adapter";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import { readProviderReplayTranscript } from "@t3tools/provider-testing/replayTranscript";
import { type ProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
  layerAcpReplaySpawner,
  makeTurnInput,
} from "./acpReplay.ts";

const fixtureDirectory = new URL("./fixtures/kiro/", import.meta.url);
const NATIVE_SESSION_ID = "native-session-1";
const decodeSettings = Schema.decodeUnknownSync(AcpRegistrySettings);

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

function segments(transcript: ProviderReplayTranscript): Array<ReadonlyArray<ProviderReplayEntry>> {
  const grouped: Array<Array<ProviderReplayEntry>> = [];
  let current: Array<ProviderReplayEntry> = [];
  for (const entry of transcript.entries) {
    current.push(entry);
    if (entry.type === "runtime_exit") {
      grouped.push(current);
      current = [];
    }
  }
  if (current.length > 0) grouped.push(current);
  return grouped;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelIdFrom(entries: ReadonlyArray<ProviderReplayEntry>): string {
  for (const entry of entries) {
    if (entry.type !== "expect_outbound" || !isRecord(entry.frame)) continue;
    if (entry.frame.method !== "session/new" || !isRecord(entry.frame.params)) continue;
    const meta = isRecord(entry.frame.params._meta) ? entry.frame.params._meta.kiro : undefined;
    if (isRecord(meta) && typeof meta.modelId === "string") return meta.modelId;
  }
  return "qwen3-coder-next";
}

function withoutModelMeta(
  entries: ReadonlyArray<ProviderReplayEntry>,
): ReadonlyArray<ProviderReplayEntry> {
  return entries.map((entry) => {
    if (entry.type !== "expect_outbound" || !isRecord(entry.frame)) return entry;
    if (entry.frame.method !== "session/new" || !isRecord(entry.frame.params)) return entry;
    const { _meta: _dropped, ...params } = entry.frame.params;
    return { ...entry, frame: { ...entry.frame, params } };
  });
}

function expectCanonicalCwd(
  entries: ReadonlyArray<ProviderReplayEntry>,
  cwd: string,
): ReadonlyArray<ProviderReplayEntry> {
  return entries.map((entry) => {
    if (entry.type !== "expect_outbound" || !isRecord(entry.frame)) return entry;
    if (!isRecord(entry.frame.params) || entry.frame.params.cwd !== "<workspace>") return entry;
    return {
      ...entry,
      frame: { ...entry.frame, params: { ...entry.frame.params, cwd } },
    };
  });
}

function withSessionClose(
  entries: ReadonlyArray<ProviderReplayEntry>,
): ReadonlyArray<ProviderReplayEntry> {
  return [
    ...entries.filter((entry) => entry.type !== "runtime_exit"),
    {
      type: "expect_outbound",
      label: "session.close",
      frame: {
        kind: "request",
        method: "session/close",
        params: { sessionId: NATIVE_SESSION_ID },
      },
    },
    {
      type: "emit_inbound",
      label: "session.closed",
      frame: { kind: "response", method: "session/close", result: {} },
    },
    { type: "runtime_exit", status: "success" },
  ];
}

const loadSegments = Effect.fn("KiroAcpReplay.loadSegments")(function* (name: string) {
  return segments(yield* readProviderReplayTranscript(new URL(`${name}.ndjson`, fixtureDirectory)));
});

const openKiro = Effect.fn("KiroAcpReplay.open")(function* (input: {
  readonly scenario: string;
  readonly entries: ReadonlyArray<ProviderReplayEntry>;
  readonly model: string;
  readonly cwd?: string;
  readonly nativeThreadId?: string;
  readonly closeSession?: boolean;
  readonly replayGate?: ProviderReplayGate;
  readonly promptStarted?: Deferred.Deferred<void>;
  readonly responseSent?: Deferred.Deferred<void>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const replayDir =
    input.cwd ?? (yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-kiro-replay-" }));
  const statusPath = path.join(replayDir, "status.json");
  const entries = input.closeSession === false ? input.entries : withSessionClose(input.entries);
  const transcript = yield* decodeAcpReplayTranscript(
    {
      provider: ACP_REGISTRY_PROVIDER,
      protocol: "acp.ndjson-jsonrpc",
      version: "1",
      scenario: input.scenario,
      entries,
    },
    ACP_REGISTRY_PROVIDER,
  );
  const replayContext = yield* Layer.build(layerAcpReplaySpawner(transcript, { statusPath }));
  const spawner = yield* Effect.service(ChildProcessSpawner.ChildProcessSpawner).pipe(
    Effect.provide(replayContext),
  );
  const promptStarted = input.promptStarted;
  const responseSent = input.responseSent;
  const instanceId = ProviderInstanceId.make(`kiro-${input.scenario}`);
  const makeRuntime = makeAcpReplayRuntime({
    transcript,
    statusPath,
    childProcessSpawner: spawner,
    fileSystem,
    ...(input.replayGate === undefined ? {} : { replayGate: input.replayGate }),
  });
  const adapter = yield* makeAcpRegistryAdapterV2({
    instanceId,
    settings: decodeSettings({ agentId: "kiro" }),
    environment: {},
    selfInvocation: yield* resolveSelfInvocation(),
    makeRuntime: (runtimeInput) =>
      makeRuntime({
        ...runtimeInput,
        ...(promptStarted === undefined
          ? {}
          : {
              requestLogger: (event) =>
                Effect.gen(function* () {
                  yield* runtimeInput.requestLogger?.(event) ?? Effect.void;
                  if (event.method === "session/prompt" && event.status === "started") {
                    yield* Deferred.succeed(promptStarted, undefined).pipe(Effect.ignore);
                  }
                }),
            }),
        ...(responseSent === undefined
          ? {}
          : {
              onOutgoingResponse: (requestId) =>
                Effect.gen(function* () {
                  yield* runtimeInput.onOutgoingResponse?.(requestId) ?? Effect.void;
                  yield* Deferred.succeed(responseSent, undefined).pipe(Effect.ignore);
                }),
            }),
      }),
    ...(input.closeSession === false
      ? {}
      : {
          assertComplete: makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript),
        }),
  }).pipe(
    Effect.provide(
      Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
        resolve: () => Effect.die("Kiro replay injects its runtime"),
      }),
    ),
  );
  const threadId = ThreadId.make(`thread-${input.scenario}`);
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: replayDir,
  });
  const modelSelection = { instanceId, model: input.model } as const;
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make(`provider-${input.scenario}`),
    modelSelection,
    runtimePolicy,
    ...(input.nativeThreadId === undefined ? {} : { initialNativeThreadId: input.nativeThreadId }),
  });
  const assistant: Array<string> = [];
  const providerThread = yield* runtime.ensureThread({
    threadId,
    modelSelection,
    runtimePolicy,
  });
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  let runningTurnId = idAllocator.derive.providerTurn({
    driver: ACP_REGISTRY_PROVIDER,
    nativeTurnId: acpScopedNativeId(instanceId, `${NATIVE_SESSION_ID}:turn:1`),
  });
  yield* runtime.events.pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => {
        if (event.type === "provider_turn.updated" && event.providerTurn.status === "running") {
          runningTurnId = event.providerTurn.id;
        }
        if (event.type === "message.updated" && event.message.role === "assistant") {
          assistant.push(event.message.text);
        }
      }),
    ),
    Effect.forkScoped,
  );
  const startTurn = runtime.startTurn(
    makeTurnInput({
      threadId,
      providerThread,
      instanceId,
      runtimePolicy,
      modelSelection,
      now: yield* DateTime.now,
    }),
  );
  return {
    runtime,
    providerThread,
    turnId: () => runningTurnId,
    assistant,
    startTurn,
    statusPath,
    fileSystem,
    transcript,
  };
});

function replayFailure(fileSystem: FileSystem.FileSystem, statusPath: string) {
  return fileSystem.readFileString(statusPath).pipe(
    Effect.map((raw) => {
      const status: unknown = JSON.parse(raw);
      return isRecord(status) ? status.failure : status;
    }),
    Effect.orElseSucceed(() => undefined),
  );
}

describe("Kiro ACP replay", () => {
  it.effect("completes one turn after Kiro negotiates ACP v1", () =>
    Effect.gen(function* () {
      const grouped = yield* loadSegments("simple");
      const segment = grouped[0] ?? [];
      const session = yield* openKiro({
        scenario: "simple",
        entries: segment,
        model: modelIdFrom(segment),
      });
      assert.equal(
        session.runtime.providerSession.capabilities.sessions.supportsModelSwitchInSession,
        false,
      );
      assert.equal(
        session.runtime.providerSession.capabilities.turns.supportsActiveSteering,
        false,
      );
      assert.equal(
        session.runtime.providerSession.capabilities.turns.supportsSteeringByInterruptRestart,
        false,
      );
      assert.equal(session.runtime.providerSession.capabilities.threads.canForkThread, false);
      assert.equal(
        session.runtime.providerSession.capabilities.threads.canReadThreadSnapshot,
        true,
      );
      assert.equal(session.runtime.providerSession.capabilities.turns.supportsInterrupt, true);
      yield* session.startTurn;
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("omits the default model sentinel from session/new", () =>
    Effect.gen(function* () {
      const grouped = yield* loadSegments("simple");
      const segment = withoutModelMeta(grouped[0] ?? []);
      const session = yield* openKiro({
        scenario: "default-model",
        entries: segment,
        model: "default",
      });
      yield* session.startTurn;
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("loads an existing session without sending a prompt", () =>
    Effect.gen(function* () {
      const grouped = yield* loadSegments("restore_load_only");
      const created = grouped[0] ?? [];
      const loaded = grouped[1] ?? [];
      const session = yield* openKiro({
        scenario: "restore-load-only",
        entries: loaded,
        model: modelIdFrom(created),
        nativeThreadId: NATIVE_SESSION_ID,
      });
      assert.equal(session.assistant.length, 0);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("fails a missing session from session/list without creating one", () =>
    Effect.gen(function* () {
      const grouped = yield* loadSegments("restore_missing");
      const loaded = grouped[1] ?? [];
      const failure = yield* openKiro({
        scenario: "restore-missing",
        entries: loaded,
        model: "qwen3-coder-next",
        nativeThreadId: "missing-native-session",
        closeSession: false,
      }).pipe(Effect.flip);
      assert.match(
        `${failure.message} ${"cause" in failure ? String(failure.cause) : ""}`,
        /not found/i,
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("recalls a loaded session with a new prompt", () =>
    Effect.gen(function* () {
      const grouped = yield* loadSegments("restore_recall");
      const created = grouped[0] ?? [];
      const loaded = grouped[1] ?? [];
      const session = yield* openKiro({
        scenario: "restore-recall",
        entries: loaded,
        model: modelIdFrom(created),
        nativeThreadId: NATIVE_SESSION_ID,
      });
      yield* session.startTurn;
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("replays an idle session whose recording has no cancel", () =>
    Effect.gen(function* () {
      const grouped = yield* loadSegments("interrupt_idle");
      const segment = grouped[0] ?? [];
      const session = yield* openKiro({
        scenario: "interrupt-idle",
        entries: segment,
        model: modelIdFrom(segment),
      });
      yield* session.startTurn;
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("cancels a prompt before Kiro starts the turn", () =>
    Effect.gen(function* () {
      const grouped = yield* loadSegments("interrupt_before_turn_started");
      const segment = grouped[0] ?? [];
      const promptStarted = yield* Deferred.make<void>();
      const session = yield* openKiro({
        scenario: "interrupt-before-turn",
        entries: segment,
        model: modelIdFrom(segment),
        promptStarted,
      });
      const turn = yield* session.startTurn.pipe(Effect.forkScoped);
      yield* Deferred.await(promptStarted);
      // The request log fires before the prompt bytes are written. One turn of
      // the event loop lets that write reach the replay agent before cancel.
      yield* Effect.promise(() => Promise.resolve());
      yield* session.runtime.interruptTurn({
        providerThread: session.providerThread,
        providerTurnId: session.turnId(),
      });
      yield* Fiber.join(turn);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("cancels a turn while a tool is still running", () =>
    Effect.gen(function* () {
      const grouped = yield* loadSegments("interrupt_mid_tool");
      const segment = grouped[0] ?? [];
      const promptStarted = yield* Deferred.make<void>();
      const responseSent = yield* Deferred.make<void>();
      const session = yield* openKiro({
        scenario: "interrupt-mid-tool",
        entries: segment,
        model: modelIdFrom(segment),
        promptStarted,
        responseSent,
      });
      const turn = yield* session.startTurn.pipe(Effect.forkScoped);
      yield* Deferred.await(promptStarted);
      yield* Effect.promise(() => Promise.resolve());
      yield* Deferred.await(responseSent);
      yield* session.runtime.interruptTurn({
        providerThread: session.providerThread,
        providerTurnId: session.turnId(),
      });
      yield* Fiber.join(turn);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("surfaces a rejected model as a provider error", () =>
    Effect.gen(function* () {
      const grouped = yield* loadSegments("provider_error");
      const segment = grouped[0] ?? [];
      const session = yield* openKiro({
        scenario: "provider-error",
        entries: segment,
        model: modelIdFrom(segment),
      });
      yield* session.startTurn;
      const mismatch = yield* replayFailure(session.fileSystem, session.statusPath);
      assert.equal(mismatch, undefined);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("opens a symlinked workspace at its canonical path", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-kiro-link-" });
      const realDirectory = path.join(parent, "real");
      const linkDirectory = path.join(parent, "link");
      yield* fileSystem.makeDirectory(realDirectory);
      yield* fileSystem.symlink(realDirectory, linkDirectory);
      const canonical = yield* fileSystem.realPath(linkDirectory);
      const grouped = yield* loadSegments("symlinked_workspace");
      const segment = expectCanonicalCwd(grouped[0] ?? [], canonical);
      const session = yield* openKiro({
        scenario: "symlinked-workspace",
        entries: segment,
        model: modelIdFrom(grouped[0] ?? []),
        cwd: linkDirectory,
      });
      yield* session.startTurn;
      assert.notEqual(linkDirectory, canonical);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});

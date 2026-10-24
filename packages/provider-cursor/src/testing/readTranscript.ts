import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { CursorAgentSdkReplayTranscript } from "./replayTranscript.ts";

const TranscriptStart = Schema.Struct({
  type: Schema.Literal("transcript_start"),
  provider: Schema.Literal("cursor"),
  protocol: Schema.Literal("cursor-agent-sdk.local"),
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

/**
 * Cursor recordings are NDJSON: one `transcript_start` header followed by the
 * replay entries. Fixtures live next to this module so Baton keeps its own
 * offline copies.
 */
export const readCursorReplayTranscript = (file: URL | string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(typeof file === "string" ? file : fileURLToPath(file));
    const lines = text.split("\n").filter((line) => line.trim() !== "");
    const header = yield* Schema.decodeUnknownEffect(TranscriptStart)(
      JSON.parse(lines[0] ?? "null"),
    );
    return yield* Schema.decodeUnknownEffect(CursorAgentSdkReplayTranscript)({
      ...header,
      entries: lines.slice(1).map((line) => JSON.parse(line) as unknown),
    });
  });

export const CURSOR_REPLAY_FIXTURES = {
  simple: new URL("./fixtures/simple.ndjson", import.meta.url),
  multiTurn: new URL("./fixtures/multi_turn.ndjson", import.meta.url),
  providerThreadResume: new URL("./fixtures/provider_thread_resume.ndjson", import.meta.url),
  turnInterruptMidTool: new URL("./fixtures/turn_interrupt_mid_tool.ndjson", import.meta.url),
  toolCallReadOnly: new URL("./fixtures/tool_call_read_only.ndjson", import.meta.url),
  subagent: new URL("./fixtures/subagent.ndjson", import.meta.url),
} as const;

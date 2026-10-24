import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import { CURSOR_REPLAY_FIXTURES, readCursorReplayTranscript } from "./readTranscript.ts";

describe("Cursor replay fixtures", () => {
  it.effect("decodes every bundled recording", () =>
    Effect.gen(function* () {
      for (const file of Object.values(CURSOR_REPLAY_FIXTURES)) {
        const transcript = yield* readCursorReplayTranscript(file);
        assert.isAbove(transcript.entries.length, 0);
        assert.strictEqual(transcript.provider, "cursor");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

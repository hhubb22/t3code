# Kiro ACP replay fixtures

These transcripts are converted from Baton's Kiro CLI 2.32.0 recordings in
`internal/agent/kiro/testdata/replay`. The converter is
`packages/provider-acp-registry/scripts/convert-kiro-replay.mjs`. It reads only
those local NDJSON files.

```sh
node packages/provider-acp-registry/scripts/convert-kiro-replay.mjs \
  <baton>/internal/agent/kiro/testdata/replay \
  packages/provider-acp-registry/src/testing/fixtures/kiro
```

The converter keeps Kiro's responses, notifications, and permission results.
It drops the `--version` probe and stderr. Client requests that T3's ACP stack
sends differently are rewritten to that shape:

- `initialize` is the negotiating request (`protocolVersion: 2` plus both v1 and
  v2 capability fields). Kiro's response stays protocol version 1, and
  `effect-acp` then uses v1.
- `session/prompt` expects two text blocks. The first carries T3's interaction
  instructions; the second is the runtime instruction block. Both texts match
  `<any>`.

A recording with more than one `kiro-cli acp` process becomes consecutive
segments separated by `runtime_exit`. Replay tests drive one segment per
adapter process. They append `session/close` when the opened session advertises
it; the original recordings stop when the Baton adapter closes the pipe.

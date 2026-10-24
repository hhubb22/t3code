#!/usr/bin/env node
// Converts Baton's Kiro ACP recordings into T3 ACP replay transcripts.
// Reads only the local NDJSON files passed on the command line.
//
//   node packages/provider-acp-registry/scripts/convert-kiro-replay.mjs \
//     <baton>/internal/agent/kiro/testdata/replay \
//     packages/provider-acp-registry/src/testing/fixtures/kiro

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const [sourceDirectory, destinationDirectory] = process.argv.slice(2);
if (sourceDirectory === undefined || destinationDirectory === undefined) {
  process.stderr.write("usage: convert-kiro-replay.mjs <source-dir> <destination-dir>\n");
  process.exit(2);
}

const T3_INITIALIZE_PARAMS = {
  protocolVersion: 2,
  info: "<any>",
  capabilities: "<any>",
  clientCapabilities: "<any>",
  clientInfo: "<any>",
};

const T3_PROMPT = [
  { type: "text", text: "<any>" },
  { type: "text", text: "<any>" },
];

function readRecords(file) {
  return NodeFS.readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function logicalFrame(frame, pendingIds) {
  if (typeof frame.method === "string") {
    const kind = frame.id === undefined || frame.id === null ? "notification" : "request";
    if (kind === "request") pendingIds.set(String(frame.id), frame.method);
    return {
      kind,
      method: frame.method,
      ...(frame.params === undefined ? {} : { params: rewriteParams(frame.method, frame.params) }),
    };
  }
  if (frame.id === undefined || frame.id === null) return undefined;
  const method = pendingIds.get(String(frame.id));
  if (method === undefined) return undefined;
  return {
    kind: "response",
    method,
    ...(frame.result === undefined ? {} : { result: frame.result }),
    ...(frame.error === undefined ? {} : { error: frame.error }),
  };
}

function rewriteParams(method, params) {
  if (method === "initialize") return T3_INITIALIZE_PARAMS;
  if (method === "session/prompt" && Array.isArray(params.prompt)) {
    return { ...params, prompt: T3_PROMPT };
  }
  return params;
}

function convertProcess(records) {
  const pendingIds = new Map();
  const entries = [];
  for (const record of records) {
    if (record.type !== "expect_outbound" && record.type !== "emit_inbound") continue;
    const frame = record.frame;
    if (typeof frame?.text === "string") continue;
    const logical = logicalFrame(frame, pendingIds);
    if (logical === undefined) {
      throw new Error(`Unpaired frame in ${record.label ?? record.type}`);
    }
    entries.push({
      type: record.type,
      ...(typeof record.label === "string" ? { label: record.label } : {}),
      frame: logical,
    });
  }
  entries.push({ type: "runtime_exit", status: "success" });
  return entries;
}

function acpProcesses(records) {
  const processes = [];
  let current = undefined;
  const finish = () => {
    if (current?.args.includes("acp")) processes.push(current.records);
    current = undefined;
  };
  for (const record of records) {
    if (record.type === "process_start") {
      finish();
      current = { args: record.args ?? [], records: [] };
      continue;
    }
    if (current === undefined) continue;
    if (record.type === "runtime_exit") {
      finish();
      continue;
    }
    current.records.push(record);
  }
  finish();
  return processes;
}

NodeFS.mkdirSync(destinationDirectory, { recursive: true });
const sources = NodeFS.readdirSync(sourceDirectory)
  .filter((name) => name.endsWith(".ndjson"))
  .toSorted();

for (const name of sources) {
  const records = readRecords(NodePath.join(sourceDirectory, name));
  const header = records.find((record) => record.type === "transcript_start") ?? {};
  const entries = acpProcesses(records).flatMap((processRecords) => convertProcess(processRecords));
  const transcript = [
    {
      type: "transcript_start",
      provider: "acpRegistry",
      protocol: "acp.ndjson-jsonrpc",
      version: "1",
      scenario: header.scenario ?? NodePath.basename(name, ".ndjson"),
      metadata: {
        source: "baton/internal/agent/kiro/testdata/replay",
        sourceScenario: header.scenario ?? NodePath.basename(name, ".ndjson"),
        agentVersion: header.agent_version ?? null,
        model: header.model ?? null,
        normalization: header.normalization ?? null,
      },
    },
    ...entries,
  ];
  const body = `${transcript.map((record) => JSON.stringify(record)).join("\n")}\n`;
  NodeFS.writeFileSync(NodePath.join(destinationDirectory, name), body);
  process.stdout.write(`${name} ${entries.length} entries\n`);
}

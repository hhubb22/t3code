import { describe, expect, it } from "@effect/vitest";

import {
  KIRO_ACP_ARGS,
  isKiroAcpSettings,
  isKiroCliBasename,
  kiroNewSessionMeta,
  kiroSpawnArgs,
} from "./kiroAcp.ts";

describe("kiroAcp", () => {
  it("recognizes the Kiro registry id and the kiro-cli binary", () => {
    expect(isKiroAcpSettings({ agentId: "kiro", commandPath: "" })).toBe(true);
    expect(isKiroAcpSettings({ agentId: "", commandPath: "/usr/local/bin/kiro-cli" })).toBe(true);
    expect(isKiroCliBasename("kiro-cli.exe")).toBe(true);
    expect(isKiroAcpSettings({ agentId: "devin", commandPath: "devin" })).toBe(false);
  });

  it("launches the V3 engine unless the instance already set arguments", () => {
    expect(kiroSpawnArgs({ command: "kiro-cli", commandArgs: [], registeredAgent: true })).toEqual(
      KIRO_ACP_ARGS,
    );
    expect(
      kiroSpawnArgs({
        command: "/opt/kiro-cli",
        commandArgs: ["acp", "--agent-engine=v3", "--verbose"],
        registeredAgent: false,
      }),
    ).toEqual(["acp", "--agent-engine=v3", "--verbose"]);
    expect(kiroSpawnArgs({ command: "other", commandArgs: [], registeredAgent: false })).toEqual(
      [],
    );
  });

  it("sends a named model on session/new and omits the default sentinel", () => {
    expect(kiroNewSessionMeta("qwen3-coder-next")).toEqual({
      kiro: { modelId: "qwen3-coder-next" },
    });
    expect(kiroNewSessionMeta("default")).toBeUndefined();
    expect(kiroNewSessionMeta("  ")).toBeUndefined();
    expect(kiroNewSessionMeta(undefined)).toBeUndefined();
  });
});

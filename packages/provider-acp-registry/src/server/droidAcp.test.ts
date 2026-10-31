import type * as EffectAcpSchema from "effect-acp/compat";
import { describe, expect, it } from "@effect/vitest";

import {
  DROID_ACP_ARGS,
  DROID_AGENT_ID,
  droidSessionModeForPolicy,
  extractDroidElicitationForm,
  isDroidAcpSettings,
  isDroidCliBasename,
} from "./droidAcp.ts";

const formRequest = () =>
  ({
    message: "Answer the questions",
    mode: "form",
    sessionId: "session-1",
    requestedSchema: {
      type: "object",
      properties: {
        question_1: {
          type: "string",
          title: "Which database?",
          description: "Pick the database to use.",
          oneOf: [
            { const: "option_1", title: "Postgres" },
            { const: "option_2", title: "SQLite" },
            { const: "other", title: "Other" },
          ],
        },
        question_1_other: { type: "string" },
        question_2: {
          type: "string",
          title: "Which region?",
          description: "Pick the deployment region.",
          oneOf: [
            { const: "option_1", title: "EU" },
            { const: "option_2", title: "US" },
            { const: "other", title: "Other" },
          ],
        },
        question_2_other: { type: "string" },
      },
      required: ["question_1", "question_2"],
    },
  }) as unknown as EffectAcpSchema.CreateElicitationRequest;

describe("droidAcp", () => {
  it("recognizes the Factory Droid registry id and the droid binary", () => {
    expect(DROID_AGENT_ID).toBe("factory-droid");
    expect(DROID_ACP_ARGS).toEqual(["exec", "--output-format", "acp"]);
    expect(isDroidAcpSettings({ agentId: "factory-droid", commandPath: "" })).toBe(true);
    expect(isDroidAcpSettings({ agentId: "", commandPath: "/usr/local/bin/droid" })).toBe(true);
    expect(isDroidCliBasename("droid.exe")).toBe(true);
    expect(isDroidCliBasename("droid.cmd")).toBe(true);
    expect(isDroidAcpSettings({ agentId: "kiro", commandPath: "kiro-cli" })).toBe(false);
    expect(isDroidCliBasename("droid-extra")).toBe(false);
  });

  it("maps runtime and interaction modes onto Droid session modes", () => {
    expect(
      droidSessionModeForPolicy({ runtimeMode: "approval-required", interactionMode: "plan" }),
    ).toBe("spec");
    expect(droidSessionModeForPolicy({ runtimeMode: "full-access", interactionMode: "plan" })).toBe(
      "spec",
    );
    expect(
      droidSessionModeForPolicy({ runtimeMode: "approval-required", interactionMode: "default" }),
    ).toBe("normal");
    expect(
      droidSessionModeForPolicy({ runtimeMode: "auto-accept-edits", interactionMode: "default" }),
    ).toBe("normal");
    expect(droidSessionModeForPolicy({ runtimeMode: "auto", interactionMode: "default" })).toBe(
      "auto-high",
    );
    expect(
      droidSessionModeForPolicy({ runtimeMode: "full-access", interactionMode: "default" }),
    ).toBe("auto-high");
  });

  it("hides the companion answer fields and restores them when responding", () => {
    const form = extractDroidElicitationForm(formRequest());
    expect(form?.questions.map((question) => question.id)).toEqual(["question_1", "question_2"]);
    expect(form?.questions[0]?.options).toEqual([
      { label: "Postgres", description: "Postgres", value: "option_1" },
      { label: "SQLite", description: "SQLite", value: "option_2" },
    ]);
    expect(
      form?.respond({ question_1: "option_2", question_2: "Write to the local disk" }),
    ).toEqual({
      action: "accept",
      content: {
        question_1: "option_2",
        question_2: "other",
        question_2_other: "Write to the local disk",
      },
    });
    expect(form?.respond({ question_1: "   ", question_2: "option_1" })).toEqual({
      action: "cancel",
    });
  });

  it("leaves other forms to the ACP fallback", () => {
    expect(extractDroidElicitationForm(formRequest())).toBeDefined();
    expect(
      extractDroidElicitationForm({
        ...formRequest(),
        mode: "url",
      } as unknown as EffectAcpSchema.CreateElicitationRequest),
    ).toBeUndefined();
    const request = formRequest();
    if (request.mode !== "form") throw new Error("Expected a form request");
    const schema = request.requestedSchema as unknown as {
      properties: Record<string, unknown>;
      required: string[];
    };
    const { question_2_other: _dropped, ...properties } = schema.properties;
    expect(
      extractDroidElicitationForm({
        ...request,
        requestedSchema: { ...schema, properties },
      } as unknown as EffectAcpSchema.CreateElicitationRequest),
    ).toBeUndefined();
    expect(
      extractDroidElicitationForm({
        ...request,
        requestedSchema: { ...schema, required: ["question_1"] },
      } as unknown as EffectAcpSchema.CreateElicitationRequest),
    ).toBeUndefined();
  });
});

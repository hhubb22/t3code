import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CodexSettings, type ServerProvider } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  applyPreferredCodexDefaultModel,
  checkCodexProviderStatus,
  mapCodexModelCapabilities,
  type CodexAppServerProviderSnapshot,
} from "./status.ts";

const defaultCodexSettings: CodexSettings = Schema.decodeSync(CodexSettings)({});

const codexModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "high", label: "High", isDefault: true },
        { id: "low", label: "Low" },
      ],
      currentValue: "high",
    },
    { id: "fastMode", label: "Fast Mode", type: "boolean" },
  ],
}) satisfies NonNullable<ServerProvider["models"][number]["capabilities"]>;

function makeCodexProbeSnapshot(
  input: Partial<CodexAppServerProviderSnapshot> = {},
): CodexAppServerProviderSnapshot {
  return {
    version: "1.0.0",
    account: {
      account: {
        type: "chatgpt",
        email: "test@example.com",
        planType: "pro",
      },
      requiresOpenaiAuth: false,
    },
    models: [
      {
        slug: "gpt-live-codex",
        name: "GPT Live Codex",
        isCustom: false,
        capabilities: codexModelCapabilities,
      },
    ],
    skills: [],
    ...input,
  };
}

it.layer(NodeServices.layer)("checkCodexProviderStatus", (it) => {
  it.effect("uses the app-server account and model list for provider status", () =>
    Effect.gen(function* () {
      const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
        Effect.succeed(
          makeCodexProbeSnapshot({
            skills: [
              {
                name: "github:gh-fix-ci",
                path: "/Users/test/.codex/skills/gh-fix-ci/SKILL.md",
                enabled: true,
                displayName: "CI Debug",
                shortDescription: "Debug failing GitHub Actions checks",
              },
            ],
          }),
        ),
      );
      assert.strictEqual(status.status, "ready");
      assert.strictEqual(status.installed, true);
      assert.strictEqual(status.version, "1.0.0");
      assert.strictEqual(status.auth.status, "authenticated");
      assert.strictEqual(status.auth.type, "chatgpt");
      assert.strictEqual(status.auth.label, "ChatGPT Pro 20x Subscription");
      assert.strictEqual(status.auth.email, "test@example.com");
      assert.deepStrictEqual(status.setup, { canAuthenticate: false, canInstall: false });
      assert.deepStrictEqual(status.models, [
        {
          slug: "gpt-live-codex",
          name: "GPT Live Codex",
          isCustom: false,
          capabilities: codexModelCapabilities,
        },
      ]);
      assert.deepStrictEqual(status.skills, [
        {
          name: "github:gh-fix-ci",
          path: "/Users/test/.codex/skills/gh-fix-ci/SKILL.md",
          enabled: true,
          displayName: "CI Debug",
          shortDescription: "Debug failing GitHub Actions checks",
        },
      ]);
      assert.deepStrictEqual(status.slashCommands.slice(1), [
        {
          name: "goal",
          description: "Set a goal Codex keeps working toward until it is done",
          input: { hint: "Objective, or pause, resume, clear" },
        },
        {
          name: "feedback",
          description: "Send this thread and Codex logs to OpenAI",
          input: { hint: "Describe the issue (optional)" },
        },
      ]);
    }),
  );

  it.effect("returns unauthenticated when app-server requires OpenAI auth", () =>
    Effect.gen(function* () {
      const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
        Effect.succeed(
          makeCodexProbeSnapshot({
            account: {
              account: null,
              requiresOpenaiAuth: true,
            },
          }),
        ),
      );

      assert.strictEqual(status.status, "error");
      assert.strictEqual(status.auth.status, "unauthenticated");
      assert.strictEqual(
        status.message,
        "Codex CLI is not authenticated. Run `codex login` and try again.",
      );
      assert.deepStrictEqual(status.usageLimits?.unavailable, {
        reason: "probeFailed",
        message: "Codex CLI is not authenticated. Run `codex login` and try again.",
      });
    }),
  );

  it.effect("returns ready with unknown auth when app-server does not require OpenAI auth", () =>
    Effect.gen(function* () {
      const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
        Effect.succeed(
          makeCodexProbeSnapshot({
            account: {
              account: null,
              requiresOpenaiAuth: false,
            },
          }),
        ),
      );

      assert.strictEqual(status.status, "ready");
      assert.strictEqual(status.auth.status, "unknown");
    }),
  );
});

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
      {
        id: "ultrafast",
        name: "Ultrafast",
        description: "The fastest available responses for latency-sensitive work.",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
        {
          id: "ultrafast",
          label: "Ultrafast",
          description: "Even faster, more expensive",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("ranks qualified Codex models while preserving their wire ids", () => {
  const models = applyPreferredCodexDefaultModel([
    {
      slug: "openai.gpt-5.6-luna",
      name: "Luna",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
    { slug: "openai.gpt-5.6-sol", name: "Sol", isCustom: false, capabilities: null },
  ]);
  assert.deepStrictEqual(
    models.filter((model) => model.isDefault).map((model) => model.slug),
    ["openai.gpt-5.6-sol"],
  );
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

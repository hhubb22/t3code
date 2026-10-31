import {
  type OrchestrationV2UserInputQuestion,
  type ProviderInteractionMode,
  type RuntimeMode,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import type { AcpAdapterV2Flavor } from "@t3tools/provider-acp/server/adapter";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

export const DROID_AGENT_ID = "factory-droid";
export const DROID_ACP_ARGS = ["exec", "--output-format", "acp"] as const;

function commandBasename(command: string): string {
  const normalized = command.trim();
  const slash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

export function isDroidCliBasename(command: string): boolean {
  return /^droid(?:\.exe|\.cmd)?$/i.test(commandBasename(command));
}

export function isDroidAcpSettings(settings: {
  readonly agentId: string;
  readonly commandPath: string;
}): boolean {
  return settings.agentId.trim() === DROID_AGENT_ID || isDroidCliBasename(settings.commandPath);
}

// Supervised and Auto-accept edits keep Droid's per-action approvals, which the
// ACP client policy answers. Auto and Full access run without asking.
export function droidSessionModeForPolicy(policy: {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}): string | undefined {
  if (policy.interactionMode === "plan") return "spec";
  switch (policy.runtimeMode) {
    case "approval-required":
    case "auto-accept-edits":
      return "normal";
    case "auto":
    case "full-access":
      return "auto-high";
  }
}

const isDroidForm = Schema.is(
  Schema.Struct({
    properties: Schema.Record(Schema.String, Schema.Unknown),
    required: Schema.Array(Schema.String),
  }),
);
const isDroidQuestion = Schema.is(
  Schema.Struct({
    type: Schema.Literal("string"),
    title: TrimmedNonEmptyString,
    description: TrimmedNonEmptyString,
    oneOf: Schema.Array(
      Schema.Struct({
        const: Schema.String.check(Schema.isPattern(/^(?:option_\d+|other)$/)),
        title: TrimmedNonEmptyString,
      }),
    ),
  }),
);
const isDroidCompanion = Schema.is(Schema.Struct({ type: Schema.Literal("string") }));

// Droid pairs each choice with an optional *_other field. The client already
// offers custom answers, so hide the companion and restore it in the response.
export const extractDroidElicitationForm: NonNullable<
  AcpAdapterV2Flavor["extractElicitationForm"]
> = (request) => {
  if (request.mode !== "form" || !isDroidForm(request.requestedSchema)) return undefined;
  const { properties, required } = request.requestedSchema;
  const questions: Array<OrchestrationV2UserInputQuestion> = [];
  for (const [id, field] of Object.entries(properties)) {
    if (!/^question_[1-9]\d*$/.test(id)) continue;
    if (!isDroidQuestion(field) || !isDroidCompanion(properties[`${id}_other`])) return undefined;
    const options = field.oneOf
      .filter((option) => option.const !== "other")
      .map((option) => ({ label: option.title, description: option.title, value: option.const }));
    if (options.length === 0 || !field.oneOf.some((option) => option.const === "other")) {
      return undefined;
    }
    questions.push({ id, header: field.title, question: field.description, options });
  }
  // Recognize only complete forms; leave every other schema to the ACP fallback.
  const requiredIds = new Set(required);
  if (
    questions.length === 0 ||
    Object.keys(properties).length !== questions.length * 2 ||
    requiredIds.size !== questions.length ||
    questions.some((question) => !requiredIds.has(question.id))
  ) {
    return undefined;
  }
  return {
    questions,
    respond: (answers) => {
      const entries: Array<[string, string]> = [];
      for (const question of questions) {
        const answer = Object.hasOwn(answers, question.id) ? answers[question.id] : undefined;
        if (!Predicate.isString(answer) || answer.trim().length === 0) return { action: "cancel" };
        if (question.options.some((option) => option.value === answer)) {
          entries.push([question.id, answer]);
        } else {
          // Intake appends server attachment references to the selected choice ID.
          const attachmentStart = answer.indexOf("\n\n");
          const selectedOption = question.options.find(
            (option) =>
              option.value === answer.slice(0, attachmentStart) &&
              /^\n\nAttached (?:image|file) "(?:\\.|[^"\\\r\n])*": "/.test(
                answer.slice(attachmentStart),
              ),
          );
          const text = selectedOption
            ? `${selectedOption.label}${answer.slice(attachmentStart)}`
            : answer;
          entries.push([question.id, "other"], [`${question.id}_other`, text]);
        }
      }
      return { action: "accept", content: Object.fromEntries(entries) };
    },
  };
};

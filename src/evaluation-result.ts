import type { EvaluationAnswers, EvaluationInput, EvaluationResult } from "./evaluation-schemas";
import { nativeConfidence } from "./native-evaluation";

// Effect optional keys represent absence, while SDK usage fields may contain undefined.
function definedProperties(value: Readonly<Record<string, unknown>> | undefined) {
  if (value === undefined) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      return entry !== undefined;
    }),
  );
}

export function formatEvaluationResult({
  input,
  result,
  mode,
  provider,
  profile,
}: {
  input: EvaluationInput;
  result: {
    answers: EvaluationAnswers;
    model: string;
    rounding?: EvaluationResult["rounding"];
    usage?: EvaluationResult["usage"];
    confidenceMetadata: unknown;
    hasWarnings: boolean;
  };
  mode: "evaluation" | "language";
  provider: string;
  profile: string;
}) {
  const metadata = Object.fromEntries(
    Object.entries(result.answers).map(([id, answer]) => {
      const question = input.questions[id]!;

      return [
        id,
        definedProperties({
          source:
            mode === "language"
              ? "model-estimate"
              : answer.type === "boolean" || answer.probabilities
                ? "provider-distribution"
                : "unavailable",
          confidence:
            answer.type === "boolean"
              ? null
              : nativeConfidence({ metadata: result.confidenceMetadata, id }),
          levels: question.type === "score" ? question.criteria : undefined,
        }),
      ];
    }),
  );

  const warnings = [
    ...(mode === "language"
      ? ["Values are model-generated estimates, not calibrated probabilities."]
      : []),
    ...(result.rounding
      ? [
          "Provider values are rounded; distributions and scores are preserved without normalization.",
        ]
      : []),
    ...(Object.values(result.answers).some((answer) => {
      return answer.type !== "boolean" && !answer.probabilities;
    })
      ? ["Some answers have no provider distribution; none was invented."]
      : []),
    ...(result.hasWarnings
      ? ["The provider reported unsupported settings or compatibility warnings."]
      : []),
  ];

  return definedProperties({
    answers: result.answers,
    metadata,
    model: result.model,
    provider,
    profile,
    rounding: definedProperties(result.rounding),
    usage: definedProperties(result.usage),
    warnings,
  });
}

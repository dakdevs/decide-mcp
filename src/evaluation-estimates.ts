import { Schema } from "effect";
import { probabilitySchema } from "./evaluation-schemas";
import type { EvaluationAnswers, EvaluationInput } from "./evaluation-schemas";

const distribution = (ids: string[]) => {
  return Schema.Struct(
    Object.fromEntries(
      ids.map((id) => {
        return [id, probabilitySchema];
      }),
    ),
  );
};

// Concrete keys keep structured output compatible with strict JSON-schema providers.
export function estimatesFor(
  questions: EvaluationInput["questions"],
): Schema.Codec<{ readonly answers: EvaluationAnswers }, unknown> {
  const fields: Record<
    string,
    Schema.Codec<EvaluationAnswers[string], unknown>
  > = Object.fromEntries(
    Object.entries(questions).map(([id, question]) => {
      if (question.type === "boolean") {
        return [
          id,
          Schema.Struct({ type: Schema.Literal("boolean"), probability: probabilitySchema }),
        ];
      }

      if (question.type === "choice") {
        const ids = Object.keys(question.criteria);

        return [
          id,
          Schema.Struct({
            type: Schema.Literal("choice"),
            choice: Schema.Literals(ids),
            probabilities: distribution(ids),
          }),
        ];
      }

      return [
        id,
        Schema.Struct({
          type: Schema.Literal("score"),
          score: Schema.Number.check(
            Schema.isBetween({ minimum: 0, maximum: question.criteria.length - 1 }),
          ),
          probabilities: distribution(
            question.criteria.map((_, index) => {
              return String(index);
            }),
          ),
        }),
      ];
    }),
  );

  return Schema.Struct({ answers: Schema.Struct(fields) });
}

import { Effect } from "effect";
import { DecisionError } from "./errors";
import type { EvaluationAnswers, EvaluationInput } from "./evaluation-schemas";

function distributionMatches({
  values,
  ids,
}: {
  values: Readonly<Record<string, number>>;
  ids: string[];
}) {
  const entries = Object.entries(values);

  return (
    entries.length === ids.length &&
    ids.every((id) => {
      return Object.hasOwn(values, id);
    }) &&
    entries.every(([, value]) => {
      return Number.isFinite(value) && value >= 0 && value <= 1;
    }) &&
    Math.abs(
      entries.reduce((sum, [, value]) => {
        return sum + value;
      }, 0) - 1,
    ) <= 0.000001
  );
}

function answerMatches({
  question,
  answer,
}: {
  question: EvaluationInput["questions"][string];
  answer: EvaluationAnswers[string];
}) {
  if (question.type === "boolean") {
    return answer.type === "boolean";
  }

  if (question.type === "choice" && answer.type === "choice") {
    const values = answer.probabilities;

    return Boolean(
      values &&
      distributionMatches({ values, ids: Object.keys(question.criteria) }) &&
      Object.hasOwn(values, answer.choice) &&
      values[answer.choice] === Math.max(...Object.values(values)),
    );
  }

  if (question.type === "score" && answer.type === "score") {
    const values = answer.probabilities;

    const ids = question.criteria.map((_, index) => {
      return String(index);
    });

    return Boolean(
      values &&
      distributionMatches({ values, ids }) &&
      Math.abs(
        answer.score -
          ids.reduce((sum, id) => {
            return sum + Number(id) * values[id]!;
          }, 0),
      ) <= 0.000001,
    );
  }

  return false;
}

export const validateGeneratedAnswers = Effect.fn("validateGeneratedAnswers")(function* ({
  questions,
  answers,
}: {
  questions: EvaluationInput["questions"];
  answers: EvaluationAnswers;
}) {
  if (
    Object.keys(questions).length !== Object.keys(answers).length ||
    !Object.entries(questions).every(([id, question]) => {
      return Object.hasOwn(answers, id) && answerMatches({ question, answer: answers[id]! });
    })
  ) {
    return yield* new DecisionError({ message: "Model returned invalid evaluation answers." });
  }

  return answers;
});

import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { Experimental_EvaluationMockModelV4, MockLanguageModelV4 } from "ai/test";
import { configSchema } from "../src/config";
import { evaluationInputSchema } from "../src/evaluation-schemas";
import { createEvaluationService } from "../src/evaluation-service";
import { nativeConfidence } from "../src/native-evaluation";

const input = {
  state: { tests: "passing", rollback: "untested" },
  questions: {
    verified: {
      type: "boolean",
      instructions: { question: "Is rollback verified?" },
      criteria: { true: "Rollback was successfully exercised.", false: "Rollback is unverified." },
    },
    action: {
      type: "choice",
      instructions: "What next?",
      criteria: { test: { description: "Exercise rollback" }, ship: "Release now", wait: null },
    },
    readiness: {
      type: "score",
      instructions: "Assess readiness.",
      criteria: [
        "Essential validation absent",
        "Tests pass; recovery unknown",
        "Tests and recovery verified",
      ],
    },
  },
} as const;
const config = Schema.decodeUnknownSync(configSchema)({
  systemPrompt: "Global policy",
  profiles: [
    {
      id: "safety",
      description: "Release safety",
      systemPrompt: "Prefer reversibility",
      model: { model: "profile-model" },
    },
  ],
});
const nativeAnswers = {
  verified: { type: "boolean", probability: 0.03 },
  action: { type: "choice", choice: "test", probabilities: { test: 0.33, ship: 0.33, wait: 0.33 } },
  readiness: { type: "score", score: 0.92, probabilities: { "0": 0.08, "1": 0.92, "2": 0 } },
} as const;

test("mixed native batch preserves structured questions, rounding, confidence and explicit policy without routing", async () => {
  const calls: Parameters<Experimental_EvaluationMockModelV4["doEvaluate"]>[0][] = [];

  const model = new Experimental_EvaluationMockModelV4({
    doEvaluate: async (options) => {
      calls.push(options);

      return {
        answers: nativeAnswers,
        rounding: { probabilityDecimals: 2, scoreDecimals: 2 },
        warnings: [{ type: "other", message: "secret provider warning" }],
        usage: { inputTokens: 120, outputTokens: 15 },
        providerMetadata: {
          typesafe: { confidence: { action: 0.01, readiness: 0.88, verified: 0.5 } },
          other: { secret: "sensitive" },
        },
      };
    },
  });

  const models: string[] = [];

  const evaluate = createEvaluationService({
    config,
    resolveModel: (selected) => {
      models.push(selected.model);

      return Effect.succeed({ mode: "evaluation", model });
    },
  });

  const result = await Effect.runPromise(evaluate({ ...input, profile: "safety" }));

  expect(calls).toHaveLength(1);

  expect(models).toEqual(["profile-model"]);

  expect(calls[0]?.state).toEqual(input.state);

  expect(calls[0]?.questions.action).toMatchObject({ criteria: input.questions.action.criteria });

  expect(calls[0]?.questions.verified?.instructions).toMatchObject({
    question: input.questions.verified.instructions,
  });

  expect(JSON.stringify(calls[0]?.questions)).toContain("Prefer reversibility");

  expect(JSON.stringify(calls[0]?.questions)).toContain("Global policy");

  expect(result.answers).toEqual(nativeAnswers);

  expect(result.metadata).toMatchObject({
    verified: { confidence: null },
    action: { confidence: 0.01, source: "provider-distribution" },
    readiness: { confidence: 0.88, levels: input.questions.readiness.criteria },
  });

  expect(result.rounding).toEqual({ probabilityDecimals: 2, scoreDecimals: 2 });

  expect(result.usage).toMatchObject({ inputTokens: 120, outputTokens: 15 });

  expect(JSON.stringify(result)).not.toContain("secret");

  expect(JSON.stringify(result)).not.toContain("sensitive");

  expect(result.profile).toBe("safety");

  const defaultResult = await Effect.runPromise(evaluate(input));

  expect(defaultResult.profile).toBe("default");

  expect(models).toEqual(["profile-model", "typesafe-ai/jev"]);

  expect(calls).toHaveLength(2);
});

test("evaluation validates input and profile before resolving a provider", async () => {
  let calls = 0;

  const evaluate = createEvaluationService({
    config,
    resolveModel: () => {
      calls++;

      return Effect.succeed({
        mode: "evaluation",
        model: new Experimental_EvaluationMockModelV4(),
      });
    },
  });

  for (const invalid of [
    { ...input, profile: "missing" },
    { ...input, extra: true },
    { ...input, questions: {} },
    { ...input, questions: { q: { ...input.questions.verified, extra: true } } },
    { ...input, questions: { q: { type: "score", instructions: "Rate", criteria: ["Only"] } } },
    { ...input, state: "x".repeat(100001) },
  ]) {
    expect((await Effect.runPromiseExit(evaluate(invalid)))._tag).toBe("Failure");
  }

  expect(calls).toBe(0);
});

test("evaluation permits 255 choices and 10 score levels but rejects excessive batches", () => {
  const choices = Object.fromEntries(
    Array.from({ length: 255 }, (_, index) => {
      return [`id${index}`, null];
    }),
  );

  const question = { type: "choice", instructions: "Select", criteria: choices };

  const decode = Schema.decodeUnknownSync(evaluationInputSchema);

  expect(decode({ state: "text", questions: { q: question } }).questions.q?.type).toBe("choice");

  expect(() => {
    return decode({
      state: "text",
      questions: { q: { ...question, criteria: { ...choices, extra: null } } },
    });
  }).toThrow();

  expect(
    decode({
      state: "text",
      questions: { q: { type: "score", instructions: "Rate", criteria: Array(10).fill("Level") } },
    }).questions.q?.type,
  ).toBe("score");

  expect(() => {
    return decode({
      state: "text",
      questions: Object.fromEntries(
        Array.from({ length: 65 }, (_, index) => {
          return [`q${index}`, input.questions.verified];
        }),
      ),
    });
  }).toThrow();
});

test("native missing distributions remain unavailable and confidence metadata is whitelisted", async () => {
  const model = new Experimental_EvaluationMockModelV4({
    doEvaluate: async () => {
      return {
        answers: {
          ...nativeAnswers,
          action: { type: "choice", choice: "test" },
          readiness: { type: "score", score: 1 },
        },
        warnings: [],
      };
    },
  });

  const result = await Effect.runPromise(
    createEvaluationService({
      config,
      resolveModel: () => {
        return Effect.succeed({ mode: "evaluation", model });
      },
    })(input),
  );

  expect(result.metadata.action).toEqual({ source: "unavailable", confidence: null });

  expect(result.answers.action).not.toHaveProperty("probabilities");

  expect(
    nativeConfidence({ metadata: { typesafe: { confidence: { action: 2 } } }, id: "action" }),
  ).toBeNull();

  expect(
    nativeConfidence({
      metadata: { typesafe: { confidence: { action: "secret" } } },
      id: "action",
    }),
  ).toBeNull();
});

const estimates = {
  verified: { type: "boolean", probability: 0.1 },
  action: { type: "choice", choice: "test", probabilities: { test: 0.7, ship: 0.2, wait: 0.1 } },
  readiness: { type: "score", score: 1.2, probabilities: { "0": 0.1, "1": 0.6, "2": 0.3 } },
} as const;
function languageModel(answers: unknown) {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: "text", text: JSON.stringify({ answers }) }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 10, text: 10, reasoning: 0 },
      },
      warnings: [],
    },
  });
}

test("language batch runs one bounded agent call and labels every estimate without inventing confidence", async () => {
  const model = languageModel(estimates);

  const result = await Effect.runPromise(
    createEvaluationService({
      config,
      resolveModel: () => {
        return Effect.succeed({ mode: "language", model });
      },
    })(input),
  );

  expect(result.answers).toEqual(estimates);

  expect(model.doGenerateCalls).toHaveLength(1);

  expect(
    Object.values(result.metadata).every((value) => {
      return value.source === "model-estimate" && value.confidence === null;
    }),
  ).toBe(true);

  expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 10 });
});

test.each([
  { ...estimates, action: { ...estimates.action, choice: "ship" } },
  {
    ...estimates,
    action: { ...estimates.action, probabilities: { test: 0.9, ship: 0.9, wait: 0.9 } },
  },
  { ...estimates, readiness: { ...estimates.readiness, score: 0.5 } },
  { ...estimates, verified: { type: "boolean", probability: 2 } },
  { action: estimates.action },
  { ...estimates, unexpected: estimates.verified },
  {
    ...estimates,
    action: { ...estimates.action, probabilities: { ...estimates.action.probabilities, extra: 0 } },
  },
])(
  "language batch rejects invalid answer semantics without another agent turn",
  async (answers) => {
    const model = languageModel(answers);

    const result = await Effect.runPromiseExit(
      createEvaluationService({
        config,
        resolveModel: () => {
          return Effect.succeed({ mode: "language", model });
        },
      })(input),
    );

    expect(result._tag).toBe("Failure");

    expect(model.doGenerateCalls).toHaveLength(1);
  },
);

test.each(["evaluation", "language"] as const)(
  "evaluation cancellation aborts the %s provider",
  async (mode) => {
    let signal: AbortSignal | undefined;

    let started!: () => void;

    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });

    const pending = ({ abortSignal }: { abortSignal?: AbortSignal }) => {
      signal = abortSignal;

      started();

      return new Promise<never>((_resolve, reject) => {
        abortSignal?.addEventListener(
          "abort",
          () => {
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    };

    const evaluate = createEvaluationService({
      config,
      resolveModel: () => {
        return mode === "evaluation"
          ? Effect.succeed({
              mode,
              model: new Experimental_EvaluationMockModelV4({ doEvaluate: pending }),
            })
          : Effect.succeed({ mode, model: new MockLanguageModelV4({ doGenerate: pending }) });
      },
    });

    const controller = new AbortController();

    const result = Effect.runPromiseExit(evaluate(input), { signal: controller.signal });

    await ready;

    controller.abort();

    expect((await result)._tag).toBe("Failure");

    expect(signal?.aborted).toBe(true);
  },
);

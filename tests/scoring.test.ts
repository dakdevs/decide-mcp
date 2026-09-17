import { Effect, Schema } from "effect";
import { describe, expect, test } from "bun:test";
import { Experimental_EvaluationMockModelV4, MockLanguageModelV4 } from "ai/test";
import { configSchema } from "../src/config";
import { createScorer, validateEstimates } from "../src/scoring";
const config = Schema.decodeUnknownSync(configSchema, {
  onExcessProperty: "error",
})({});
const input = {
  decision: "Ship?",
  context: "Tests pass.",
  choices: [
    { id: "ship", description: "Ship now" },
    { id: "wait", description: "Wait" },
  ],
};
const args = {
  input,
  model: config.model,
  systemPrompt: "Prefer reliability.",
};
describe("probability integrity", () => {
  test("preserves native probabilities and does not confuse confidence with probability", async () => {
    const model = new Experimental_EvaluationMockModelV4({
      doEvaluate: async (options) => {
        expect(options.questions.decision?.instructions).toContain("Prefer reliability");

        expect(options.state).toEqual(input);

        return {
          answers: {
            decision: {
              type: "choice",
              choice: "ship",
              probabilities: { ship: 0.73, wait: 0.27 },
            },
          },
          warnings: [],
          providerMetadata: { typesafe: { confidence: { decision: 0.99 } } },
        };
      },
    });

    const score = createScorer({
      config,
      resolveModel: () => {
        return Effect.succeed({ mode: "evaluation", model });
      },
    });

    expect(await Effect.runPromise(score(args))).toMatchObject({
      selectedChoice: "ship",
      confidence: 0.99,
      choices: [
        { id: "ship", percentage: 73 },
        { id: "wait", percentage: 27 },
      ],
      percentageSource: "provider-distribution",
    });
  });

  test("keeps absent distributions absent", async () => {
    const model = new Experimental_EvaluationMockModelV4({
      doEvaluate: async () => {
        return {
          answers: { decision: { type: "choice", choice: "ship" } },
          warnings: [],
        };
      },
    });

    const result = await Effect.runPromise(
      createScorer({
        config,
        resolveModel: () => {
          return Effect.succeed({ mode: "evaluation", model });
        },
      })(args),
    );

    expect(result.percentageSource).toBe("unavailable");

    expect(
      result.choices.every((choice) => {
        return choice.percentage === null;
      }),
    ).toBe(true);
  });

  test("SDK rejects malformed native distributions", async () => {
    const model = new Experimental_EvaluationMockModelV4({
      doEvaluate: async () => {
        return {
          answers: {
            decision: {
              type: "choice",
              choice: "ship",
              probabilities: { ship: 0.9, wait: 0.9 },
            },
          },
          warnings: [],
        };
      },
    });

    await expect(
      Effect.runPromise(
        createScorer({
          config,
          resolveModel: () => {
            return Effect.succeed({ mode: "evaluation", model });
          },
        })(args),
      ),
    ).rejects.toThrow();
  });

  test("keeps provider rounding without normalization", async () => {
    const threeChoices = [...input.choices, { id: "review", description: "Review first" }];

    const model = new Experimental_EvaluationMockModelV4({
      doEvaluate: async () => {
        return {
          answers: {
            decision: {
              type: "choice",
              choice: "ship",
              probabilities: { ship: 0.33, wait: 0.33, review: 0.33 },
            },
          },
          rounding: { probabilityDecimals: 2 },
          warnings: [],
        };
      },
    });

    const result = await Effect.runPromise(
      createScorer({
        config,
        resolveModel: () => {
          return Effect.succeed({ mode: "evaluation", model });
        },
      })({ ...args, input: { ...input, choices: threeChoices } }),
    );

    expect(
      result.choices.map((choice) => {
        return choice.percentage;
      }),
    ).toEqual([33, 33, 33]);

    expect(result.warnings.join(" ")).toContain("rounded");
  });

  test("validates estimated option coverage and sums", () => {
    for (const estimates of [
      [{ id: "ship", probability: 1 }],
      [
        { id: "ship", probability: 0.5 },
        { id: "ship", probability: 0.5 },
      ],
      [
        { id: "ship", probability: 0.5 },
        { id: "other", probability: 0.5 },
      ],
      [
        { id: "ship", probability: 0.8 },
        { id: "wait", probability: 0.8 },
      ],
      [
        { id: "ship", probability: NaN },
        { id: "wait", probability: 0.5 },
      ],
    ]) {
      expect(() => {
        return Effect.runSync(validateEstimates({ choices: input.choices, estimates }));
      }).toThrow();
    }
  });

  test("language estimates use input-order tie-breaking and carry a source label", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              choices: [
                { id: "wait", probability: 0.5 },
                { id: "ship", probability: 0.5 },
              ],
            }),
          },
        ],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 10, text: 10, reasoning: 0 },
        },
        warnings: [],
      },
    });

    const result = await Effect.runPromise(
      createScorer({
        config,
        resolveModel: () => {
          return Effect.succeed({ mode: "language", model });
        },
      })(args),
    );

    expect(result.selectedChoice).toBe("ship");

    expect(result.percentageSource).toBe("model-estimate");

    expect(model.doGenerateCalls[0]?.prompt[0]).toMatchObject({
      role: "system",
    });
  });
});

test.each(["evaluation", "language"] as const)(
  "Effect interruption aborts the %s provider request",
  async (mode) => {
    let providerSignal: AbortSignal | undefined;

    let started!: () => void;

    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });

    const pending = ({ abortSignal }: { abortSignal?: AbortSignal }) => {
      providerSignal = abortSignal;

      started();

      return new Promise<never>((_resolve, reject) => {
        return abortSignal?.addEventListener(
          "abort",
          () => {
            return reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    };

    const score = createScorer({
      config,
      resolveModel: () => {
        return mode === "evaluation"
          ? Effect.succeed({
              mode,
              model: new Experimental_EvaluationMockModelV4({
                doEvaluate: pending,
              }),
            })
          : Effect.succeed({
              mode,
              model: new MockLanguageModelV4({ doGenerate: pending }),
            });
      },
    });

    const controller = new AbortController();

    const running = Effect.runPromise(score({ ...args, model: { ...args.model, mode } }), {
      signal: controller.signal,
    });

    const outcome = running.then(
      () => {
        return false;
      },
      () => {
        return true;
      },
    );

    await ready;

    controller.abort();

    expect(await outcome).toBe(true);

    expect(providerSignal?.aborted).toBe(true);
  },
);

test("language agent isolates concurrent requests and preserves provider settings", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              choices: [
                { id: "ship", probability: 0.6 },
                { id: "wait", probability: 0.4 },
              ],
            }),
          },
        ],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: options.providerOptions?.fixture?.warn
          ? [{ type: "other", message: "fixture warning" }]
          : [],
      };
    },
  });

  const score = createScorer({
    config,
    resolveModel: () => {
      return Effect.succeed({ mode: "language", model });
    },
  });

  const results = await Effect.runPromise(
    Effect.all(
      ["first-private-context", "second-private-context"].map((context) => {
        return score({
          ...args,
          input: { ...input, context },
          model: {
            ...args.model,
            mode: "language",
            providerOptions: { fixture: { warn: true } },
          },
        });
      }),
      { concurrency: "unbounded" },
    ),
  );

  expect(model.doGenerateCalls).toHaveLength(2);

  const prompts = model.doGenerateCalls.map((call) => {
    return JSON.stringify(call.prompt);
  });

  for (const prompt of prompts) {
    expect(
      prompt.includes("first-private-context") !== prompt.includes("second-private-context"),
    ).toBe(true);
  }

  expect(
    results.every((result) => {
      return result.warnings.some((warning) => {
        return warning.includes("unsupported settings");
      });
    }),
  ).toBe(true);

  expect(
    model.doGenerateCalls.every((call) => {
      return call.responseFormat?.type === "json";
    }),
  ).toBe(true);
});

test.each([
  "not-json",
  JSON.stringify({
    choices: [
      { id: "ship", probability: 0.8 },
      { id: "wait", probability: 0.8 },
    ],
  }),
])("language agent rejects invalid output without additional model turns", async (text) => {
  const model = new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    },
  });

  const score = createScorer({
    config,
    resolveModel: () => {
      return Effect.succeed({ mode: "language", model });
    },
  });

  await expect(
    Effect.runPromise(score({ ...args, model: { ...args.model, mode: "language" } })),
  ).rejects.toThrow();

  expect(model.doGenerateCalls).toHaveLength(1);
});

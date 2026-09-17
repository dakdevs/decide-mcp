import { describe, expect, test } from "bun:test";
import {
  Experimental_EvaluationMockModelV4,
  MockLanguageModelV4,
} from "ai/test";
import { configSchema } from "../src/config.js";
import { createScorer, validateEstimates } from "../src/scoring.js";

const config = configSchema.parse({});
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
  signal: new AbortController().signal,
};

describe("probability integrity", () => {
  test("preserves native probabilities and does not confuse confidence with probability", async () => {
    const model = new Experimental_EvaluationMockModelV4({
      doEvaluate: async (options) => {
        expect(options.questions.decision?.instructions).toContain(
          "Prefer reliability",
        );
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
      resolveModel: () => ({ mode: "evaluation", model }),
    });
    expect(await score(args)).toMatchObject({
      selectedChoice: "ship",
      choices: [
        { id: "ship", percentage: 73 },
        { id: "wait", percentage: 27 },
      ],
      percentageSource: "provider-distribution",
    });
  });
  test("keeps absent distributions absent", async () => {
    const model = new Experimental_EvaluationMockModelV4({
      doEvaluate: async () => ({
        answers: { decision: { type: "choice", choice: "ship" } },
        warnings: [],
      }),
    });
    const result = await createScorer({
      config,
      resolveModel: () => ({ mode: "evaluation", model }),
    })(args);
    expect(result.percentageSource).toBe("unavailable");
    expect(result.choices.every((choice) => choice.percentage === null)).toBe(
      true,
    );
  });
  test("SDK rejects malformed native distributions", async () => {
    const model = new Experimental_EvaluationMockModelV4({
      doEvaluate: async () => ({
        answers: {
          decision: {
            type: "choice",
            choice: "ship",
            probabilities: { ship: 0.9, wait: 0.9 },
          },
        },
        warnings: [],
      }),
    });
    await expect(
      createScorer({
        config,
        resolveModel: () => ({ mode: "evaluation", model }),
      })(args),
    ).rejects.toThrow();
  });
  test("keeps provider rounding without normalization", async () => {
    const threeChoices = [
      ...input.choices,
      { id: "review", description: "Review first" },
    ];
    const model = new Experimental_EvaluationMockModelV4({
      doEvaluate: async () => ({
        answers: {
          decision: {
            type: "choice",
            choice: "ship",
            probabilities: { ship: 0.33, wait: 0.33, review: 0.33 },
          },
        },
        rounding: { probabilityDecimals: 2 },
        warnings: [],
      }),
    });
    const result = await createScorer({
      config,
      resolveModel: () => ({ mode: "evaluation", model }),
    })({ ...args, input: { ...input, choices: threeChoices } });
    expect(result.choices.map((choice) => choice.percentage)).toEqual([
      33, 33, 33,
    ]);
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
    ])
      expect(() =>
        validateEstimates({ choices: input.choices, estimates }),
      ).toThrow();
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
    const result = await createScorer({
      config,
      resolveModel: () => ({ mode: "language", model }),
    })(args);
    expect(result.selectedChoice).toBe("ship");
    expect(result.percentageSource).toBe("model-estimate");
    expect(model.doGenerateCalls[0]?.prompt[0]).toMatchObject({
      role: "system",
    });
  });
});

import { expect, test } from "bun:test";
import { configSchema } from "../src/config.js";
import { createDecisionService } from "../src/decision-service.js";
import type { Scorer } from "../src/scoring.js";

const input = {
  decision: "Ship?",
  context: "Tests pass.",
  choices: [
    { id: "ship", description: "Ship now" },
    { id: "wait", description: "Wait" },
  ],
};
const profile = {
  id: "safety",
  description: "Decisions about reliability",
  systemPrompt: "Favor reversible actions.",
};

test("automatic routing chooses a profile, applies global and profile policies, and shares one deadline", async () => {
  const config = configSchema.parse({
    systemPrompt: "Global rule",
    profiles: [{ ...profile, model: { model: "special-model" } }],
  });
  const calls: Parameters<Scorer>[0][] = [];
  const score: Scorer = async (args) => {
    calls.push(args);
    return {
      selectedChoice: calls.length === 1 ? "safety" : "wait",
      choices:
        calls.length === 1
          ? [
              { id: "default", percentage: 10 },
              { id: "safety", percentage: 90 },
            ]
          : [
              { id: "ship", percentage: 20 },
              { id: "wait", percentage: 80 },
            ],
      percentageSource: "provider-distribution",
      model: args.model.model,
      provider: args.model.provider,
      warnings: [],
    };
  };
  const result = await createDecisionService({ config, score })({ input });
  expect(result.profile).toBe("safety");
  expect(result.routing).toMatchObject({
    mode: "automatic",
    selectedPercentage: 90,
    fallback: false,
  });
  expect(calls[1]?.systemPrompt).toContain("Global rule");
  expect(calls[1]?.systemPrompt).toContain("Favor reversible actions.");
  expect(calls[1]?.model.model).toBe("special-model");
  expect(calls[0]?.signal).toBe(calls[1]?.signal);
});

test.each([null, 40])(
  "routing threshold falls back to default for %s percent",
  async (percentage) => {
    const config = configSchema.parse({
      profiles: [profile],
      router: { minimumProbability: 0.8 },
    });
    let count = 0;
    const score: Scorer = async (args) => ({
      selectedChoice: ++count === 1 ? "safety" : "ship",
      choices:
        count === 1
          ? [{ id: "safety", percentage }]
          : [
              { id: "ship", percentage: 100 },
              { id: "wait", percentage: 0 },
            ],
      percentageSource:
        percentage === null ? "unavailable" : "provider-distribution",
      model: args.model.model,
      provider: args.model.provider,
      warnings: [],
    });
    const result = await createDecisionService({ config, score })({ input });
    expect(result.profile).toBe("default");
    expect(result.routing).toMatchObject({
      proposedProfile: "safety",
      fallback: true,
    });
  },
);

test("explicit profiles bypass routing and unknown profiles fail before provider I/O", async () => {
  const config = configSchema.parse({ profiles: [profile], tools: "both" });
  let count = 0;
  const score: Scorer = async (args) => {
    count++;
    return {
      selectedChoice: "ship",
      choices: [
        { id: "ship", percentage: 100 },
        { id: "wait", percentage: 0 },
      ],
      percentageSource: "provider-distribution",
      model: args.model.model,
      provider: args.model.provider,
      warnings: [],
    };
  };
  const decide = createDecisionService({ config, score });
  expect((await decide({ input, profileId: "safety" })).routing.mode).toBe(
    "explicit",
  );
  expect(count).toBe(1);
  await expect(decide({ input, profileId: "missing" })).rejects.toThrow(
    "Unknown profile",
  );
  expect(count).toBe(1);
});

test("already cancelled requests never call a provider", async () => {
  const config = configSchema.parse({});
  const decide = createDecisionService({
    config,
    score: async () => {
      throw new Error("provider should not run");
    },
  });
  await expect(
    decide({ input, signal: AbortSignal.abort(new Error("cancelled")) }),
  ).rejects.toThrow("cancelled");
});

import { Effect, Schema } from "effect";
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
  const config = Schema.decodeUnknownSync(configSchema, {
    onExcessProperty: "error",
  })({
    systemPrompt: "Global rule",
    profiles: [{ ...profile, model: { model: "special-model" } }],
  });
  const calls: Parameters<Scorer>[0][] = [];
  const score: Scorer = (args) =>
    Effect.sync(() => {
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
    });
  const result = await Effect.runPromise(
    createDecisionService({ config, score })({ input }),
  );
  expect(result.profile).toBe("safety");
  expect(result.routing).toMatchObject({
    mode: "automatic",
    selectedPercentage: 90,
    fallback: false,
  });
  expect(calls[1]?.systemPrompt).toContain("Global rule");
  expect(calls[1]?.systemPrompt).toContain("Favor reversible actions.");
  expect(calls[1]?.model.model).toBe("special-model");
});
test.each([null, 40])(
  "routing threshold falls back to default for %s percent",
  async (percentage) => {
    const config = Schema.decodeUnknownSync(configSchema, {
      onExcessProperty: "error",
    })({
      profiles: [profile],
      router: { minimumProbability: 0.8 },
    });
    let count = 0;
    const score: Scorer = (args) =>
      Effect.sync(() => ({
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
      }));
    const result = await Effect.runPromise(
      createDecisionService({ config, score })({ input }),
    );
    expect(result.profile).toBe("default");
    expect(result.routing).toMatchObject({
      proposedProfile: "safety",
      fallback: true,
    });
  },
);
test("explicit profiles bypass routing and unknown profiles fail before provider I/O", async () => {
  const config = Schema.decodeUnknownSync(configSchema, {
    onExcessProperty: "error",
  })({ profiles: [profile], tools: "both" });
  let count = 0;
  const score: Scorer = (args) =>
    Effect.sync(() => {
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
    });
  const decide = createDecisionService({ config, score });
  expect(
    (await Effect.runPromise(decide({ input, profileId: "safety" }))).routing
      .mode,
  ).toBe("explicit");
  expect(count).toBe(1);
  await expect(
    Effect.runPromise(decide({ input, profileId: "missing" })),
  ).rejects.toThrow("Unknown profile");
  expect(count).toBe(1);
});

test("already interrupted requests never call a provider", async () => {
  const config = Schema.decodeUnknownSync(configSchema)({});
  let calls = 0;
  const decide = createDecisionService({
    config,
    score: () =>
      Effect.sync(() => {
        calls++;
        throw new Error("provider should not run");
      }),
  });
  await expect(
    Effect.runPromise(Effect.interrupt.pipe(Effect.andThen(decide({ input })))),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});

test("one Effect deadline interrupts routing and scoring together", async () => {
  const { TestClock } = await import("effect/testing");
  const { Fiber, Exit } = await import("effect");
  const config = Schema.decodeUnknownSync(configSchema)({
    profiles: [profile],
    timeoutMs: 100,
  });
  let calls = 0;
  let finalized = 0;
  const score: Scorer = (args) =>
    Effect.gen(function* () {
      const route = ++calls === 1;
      yield* Effect.sleep(60);
      return {
        selectedChoice: route ? "safety" : "ship",
        choices: [{ id: route ? "safety" : "ship", percentage: 100 }],
        percentageSource: "provider-distribution" as const,
        model: args.model.model,
        provider: args.model.provider,
        warnings: [],
      };
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          finalized++;
        }),
      ),
    );
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        createDecisionService({ config, score })({ input }),
      );
      yield* TestClock.adjust(100);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(String(exit.cause)).toContain("TimeoutError");
      expect(calls).toBe(2);
      expect(finalized).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

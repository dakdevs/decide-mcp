import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import { describe, expect, test } from "bun:test";
import { configSchema, loadConfig } from "../src/config.js";
import { decisionSchema } from "../src/schemas.js";
describe("configuration and request validation", () => {
  test("defaults to native Jev evaluation through Gateway", () => {
    expect(
      Schema.decodeUnknownSync(configSchema, { onExcessProperty: "error" })({})
        .model,
    ).toEqual({
      provider: "gateway",
      model: "typesafe-ai/jev",
      mode: "evaluation",
    });
  });
  test("rejects unknown providers, duplicate profiles, and reserved IDs", () => {
    expect(() =>
      Schema.decodeUnknownSync(configSchema, { onExcessProperty: "error" })({
        model: { provider: "missing", model: "x" },
      }),
    ).toThrow("Unknown provider");
    const profile = {
      id: "cost",
      description: "Cost",
      systemPrompt: "Save money",
    };
    expect(() =>
      Schema.decodeUnknownSync(configSchema, { onExcessProperty: "error" })({
        profiles: [profile, profile],
      }),
    ).toThrow("unique");
    expect(() =>
      Schema.decodeUnknownSync(configSchema, { onExcessProperty: "error" })({
        profiles: [{ ...profile, id: "default" }],
      }),
    ).toThrow("reserved");
    expect(() =>
      Schema.decodeUnknownSync(configSchema, { onExcessProperty: "error" })({
        profiles: [{ ...profile, id: "UPPER_CASE" }],
      }),
    ).toThrow();
  });
  test("rejects invalid provider factories and unknown config fields", () => {
    expect(() =>
      Schema.decodeUnknownSync(configSchema, { onExcessProperty: "error" })({
        providers: { custom: { kind: "custom" } },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(configSchema, { onExcessProperty: "error" })({
        providers: { local: { kind: "openai-compatible" } },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(configSchema, { onExcessProperty: "error" })({
        systemPromt: "misspelled",
      }),
    ).toThrow();
  });
  test("supports inline config and rejects conflicting sources", async () => {
    expect(
      (
        await Effect.runPromise(
          Effect.provide(
            loadConfig({ json: '{"tools":"both"}' }),
            NodeFileSystem.layer,
          ),
        )
      ).config.tools,
    ).toBe("both");
    await expect(
      Effect.runPromise(
        Effect.provide(
          loadConfig({ json: "{}", path: "/tmp/no-file" }),
          NodeFileSystem.layer,
        ),
      ),
    ).rejects.toThrow("either");
    await expect(
      Effect.runPromise(
        Effect.provide(loadConfig({ json: "{invalid" }), NodeFileSystem.layer),
      ),
    ).rejects.toThrow();
  });
  test("requires context, multiple distinct options, and bounded input", () => {
    const valid = {
      decision: "Ship?",
      context: { tests: "pass" },
      choices: [
        { id: "yes", description: "Ship" },
        { id: "no", description: "Wait" },
      ],
    };
    expect(
      Schema.decodeUnknownSync(decisionSchema, { onExcessProperty: "error" })(
        valid,
      ),
    ).toEqual(valid);
    expect(() =>
      Schema.decodeUnknownSync(decisionSchema, { onExcessProperty: "error" })({
        ...valid,
        context: undefined,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(decisionSchema, { onExcessProperty: "error" })({
        ...valid,
        choices: [valid.choices[0], valid.choices[0]],
      }),
    ).toThrow("unique");
    expect(() =>
      Schema.decodeUnknownSync(decisionSchema, { onExcessProperty: "error" })({
        ...valid,
        context: { huge: "x".repeat(100001) },
      }),
    ).toThrow();
  });
});

test("configuration decoding rejects nested unknown fields and preserves defaults", async () => {
  for (const raw of [
    { model: { model: "jev", mod: "language" } },
    { router: { minimumProbablity: 0.8 } },
    { providers: { gateway: { kind: "gateway", apiKey: "should-use-env" } } },
  ]) {
    await expect(
      Effect.runPromise(
        loadConfig({ json: JSON.stringify(raw) }).pipe(
          Effect.provide(NodeFileSystem.layer),
        ),
      ),
    ).rejects.toThrow();
  }
  const { config } = await Effect.runPromise(
    loadConfig({
      json: '{"model":{"model":" typesafe-ai/jev "},"router":{}}',
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
  expect(config.model).toEqual({
    provider: "gateway",
    model: "typesafe-ai/jev",
    mode: "evaluation",
  });
  expect(config.router.minimumProbability).toBe(0);
});

import { describe, expect, test } from "bun:test";
import { configSchema, loadConfig } from "../src/config.js";
import { decisionSchema } from "../src/schemas.js";

describe("configuration and request validation", () => {
  test("defaults to native Jev evaluation through Gateway", () => {
    expect(configSchema.parse({}).model).toEqual({
      provider: "gateway",
      model: "typesafe-ai/jev",
      mode: "evaluation",
    });
  });
  test("rejects unknown providers, duplicate profiles, and reserved IDs", () => {
    expect(() =>
      configSchema.parse({ model: { provider: "missing", model: "x" } }),
    ).toThrow("Unknown provider");
    const profile = {
      id: "cost",
      description: "Cost",
      systemPrompt: "Save money",
    };
    expect(() => configSchema.parse({ profiles: [profile, profile] })).toThrow(
      "unique",
    );
    expect(() =>
      configSchema.parse({ profiles: [{ ...profile, id: "default" }] }),
    ).toThrow("reserved");
    expect(() =>
      configSchema.parse({ profiles: [{ ...profile, id: "UPPER_CASE" }] }),
    ).toThrow();
  });
  test("rejects invalid provider factories and unknown config fields", () => {
    expect(() =>
      configSchema.parse({ providers: { custom: { kind: "custom" } } }),
    ).toThrow();
    expect(() =>
      configSchema.parse({
        providers: { local: { kind: "openai-compatible" } },
      }),
    ).toThrow();
    expect(() => configSchema.parse({ systemPromt: "misspelled" })).toThrow();
  });
  test("supports inline config and rejects conflicting sources", async () => {
    expect((await loadConfig({ json: '{"tools":"both"}' })).config.tools).toBe(
      "both",
    );
    await expect(
      loadConfig({ json: "{}", path: "/tmp/no-file" }),
    ).rejects.toThrow("either");
    await expect(loadConfig({ json: "{invalid" })).rejects.toThrow();
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
    expect(decisionSchema.parse(valid)).toEqual(valid);
    expect(() =>
      decisionSchema.parse({ ...valid, context: undefined }),
    ).toThrow();
    expect(() =>
      decisionSchema.parse({
        ...valid,
        choices: [valid.choices[0], valid.choices[0]],
      }),
    ).toThrow("unique");
    expect(() =>
      decisionSchema.parse({ ...valid, context: { huge: "x".repeat(100001) } }),
    ).toThrow();
  });
});

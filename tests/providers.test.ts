import { Effect, Schema } from "effect";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema } from "../src/config.js";
import { createModelResolver } from "../src/providers.js";
test("loads a custom provider relative to the config file and passes settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "decide-provider-"));
  try {
    await writeFile(
      join(directory, "custom-provider.mjs"),
      'export function createProvider(options) { return { evaluationModel(id) { return { specificationVersion: "v4", provider: options.name, modelId: id }; } }; }',
    );
    const config = Schema.decodeUnknownSync(configSchema, {
      onExcessProperty: "error",
    })({
      model: { provider: "custom", model: "my-model" },
      providers: {
        custom: {
          kind: "custom",
          module: "./custom-provider.mjs",
          export: "createProvider",
          options: { name: "custom-test" },
        },
      },
    });
    const resolver = await Effect.runPromise(
      createModelResolver({
        config,
        baseDirectory: directory,
      }),
    );
    expect(Effect.runSync(resolver(config.model))).toMatchObject({
      mode: "evaluation",
      model: { provider: "custom-test", modelId: "my-model" },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("rejects missing credentials without exposing other environment values", async () => {
  const config = Schema.decodeUnknownSync(configSchema, {
    onExcessProperty: "error",
  })({
    providers: {
      gateway: {
        kind: "gateway",
        apiKeyEnv: "DECIDE_TEST_MISSING_CREDENTIAL_123",
      },
    },
  });
  await expect(
    Effect.runPromise(
      createModelResolver({ config, baseDirectory: process.cwd() }),
    ),
  ).rejects.toThrow("Missing environment variable");
});
test("rejects evaluation mode on a language-only provider", async () => {
  const config = Schema.decodeUnknownSync(configSchema, {
    onExcessProperty: "error",
  })({
    model: { provider: "local", model: "local-model" },
    providers: {
      local: { kind: "openai-compatible", baseURL: "http://localhost:9999/v1" },
    },
  });
  const resolver = await Effect.runPromise(
    createModelResolver({
      config,
      baseDirectory: process.cwd(),
    }),
  );
  expect(() => Effect.runSync(resolver(config.model))).toThrow(
    "does not support evaluation",
  );
});

import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createGateway } from "@ai-sdk/gateway";
import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Experimental_EvaluationModel, LanguageModel } from "ai";
import { Effect } from "effect";
import type { Config, ModelConfig } from "./config.js";
import { ProviderError } from "./errors.js";

type Provider = {
  evaluationModel?: (id: string) => Experimental_EvaluationModel;
  languageModel?: (id: string) => LanguageModel;
};

const createProvider = Effect.fn("createProvider")(function* ({
  name,
  definition,
  baseDirectory,
}: {
  name: string;
  definition: Config["providers"][string];
  baseDirectory: string;
}) {
  const apiKey = definition.apiKeyEnv
    ? process.env[definition.apiKeyEnv]
    : undefined;
  if (definition.apiKeyEnv && !apiKey)
    return yield* new ProviderError({
      message: `Missing environment variable: ${definition.apiKeyEnv}`,
    });
  const settings = { apiKey, baseURL: definition.baseURL };
  const failure = () =>
    new ProviderError({
      message: `Provider ${name}: initialization failed. Check factory and settings.`,
    });
  if (definition.kind !== "custom")
    return yield* Effect.try({
      try: (): Provider => {
        switch (definition.kind) {
          case "gateway":
            return createGateway(settings);
          case "typesafe":
            return createTypeSafeAi(settings);
          case "openai":
            return createOpenAI(settings);
          case "anthropic":
            return createAnthropic(settings);
          case "google":
            return createGoogleGenerativeAI(settings);
          case "openai-compatible":
            return createOpenAICompatible({
              ...settings,
              name,
              baseURL: definition.baseURL!,
            });
          default:
            throw new Error("Expected built-in provider");
        }
      },
      catch: failure,
    });
  const moduleUrl = yield* Effect.try({
    try: () => {
      const specifier = definition.module!;
      const require = createRequire(resolve(baseDirectory, "package.json"));
      return pathToFileURL(
        specifier.startsWith(".") || specifier.startsWith("/")
          ? resolve(baseDirectory, specifier)
          : require.resolve(specifier),
      ).href;
    },
    catch: failure,
  });
  const imported: Record<string, unknown> = yield* Effect.tryPromise({
    try: () => import(moduleUrl),
    catch: failure,
  });
  const factory = imported[definition.export!];
  if (typeof factory !== "function") return yield* failure();
  const provider: Provider = yield* Effect.tryPromise({
    try: () =>
      Promise.resolve(
        factory({
          ...definition.options,
          ...Object.fromEntries(
            Object.entries(settings).filter(([, value]) => value !== undefined),
          ),
        }),
      ),
    catch: failure,
  });
  if (
    !provider ||
    (typeof provider !== "object" && typeof provider !== "function")
  )
    return yield* failure();
  return provider;
});

export const createModelResolver = Effect.fn("createModelResolver")(function* ({
  config,
  baseDirectory,
}: {
  config: Config;
  baseDirectory: string;
}) {
  const entries = yield* Effect.forEach(
    Object.entries(config.providers),
    ([name, definition]) =>
      createProvider({ name, definition, baseDirectory }).pipe(
        Effect.map((provider) => [name, provider] as const),
      ),
  );
  const providers = new Map(entries);
  return (model: ModelConfig) =>
    Effect.try({
      try: () => {
        const provider = providers.get(model.provider);
        if (model.mode === "evaluation") {
          if (typeof provider?.evaluationModel !== "function")
            throw new Error("Evaluation mode unavailable");
          return {
            mode: "evaluation" as const,
            model: provider.evaluationModel(model.model),
          };
        }
        if (typeof provider?.languageModel !== "function")
          throw new Error("Language mode unavailable");
        return {
          mode: "language" as const,
          model: provider.languageModel(model.model),
        };
      },
      catch: () =>
        new ProviderError({
          message: `Provider ${model.provider} does not support ${model.mode} mode or model.`,
        }),
    });
});
export type ModelResolver = Effect.Success<
  ReturnType<typeof createModelResolver>
>;

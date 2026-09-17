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
import type { Config, ModelConfig } from "./config.js";

type Provider = {
  evaluationModel?: (id: string) => Experimental_EvaluationModel;
  languageModel?: (id: string) => LanguageModel;
};

export async function createModelResolver({
  config,
  baseDirectory,
}: {
  config: Config;
  baseDirectory: string;
}) {
  const providers = new Map<string, Provider>();
  for (const [name, definition] of Object.entries(config.providers)) {
    const apiKey = definition.apiKeyEnv
      ? process.env[definition.apiKeyEnv]
      : undefined;
    if (definition.apiKeyEnv && !apiKey)
      throw new Error(`Missing environment variable: ${definition.apiKeyEnv}`);
    const settings = { apiKey, baseURL: definition.baseURL };
    let provider: Provider;
    switch (definition.kind) {
      case "gateway":
        provider = createGateway(settings);
        break;
      case "typesafe":
        provider = createTypeSafeAi(settings);
        break;
      case "openai":
        provider = createOpenAI(settings);
        break;
      case "anthropic":
        provider = createAnthropic(settings);
        break;
      case "google":
        provider = createGoogleGenerativeAI(settings);
        break;
      case "openai-compatible":
        provider = createOpenAICompatible({
          ...settings,
          name,
          baseURL: definition.baseURL!,
        });
        break;
      case "custom": {
        const specifier = definition.module!;
        const require = createRequire(resolve(baseDirectory, "package.json"));
        const modulePath =
          specifier.startsWith(".") || specifier.startsWith("/")
            ? resolve(baseDirectory, specifier)
            : require.resolve(specifier);
        const imported: Record<string, unknown> = await import(
          pathToFileURL(modulePath).href
        );
        const factory = imported[definition.export!];
        if (typeof factory !== "function")
          throw new Error(
            `Provider ${name}: export must be a factory function.`,
          );
        provider = await factory({
          ...definition.options,
          ...Object.fromEntries(
            Object.entries(settings).filter(([, value]) => value !== undefined),
          ),
        });
        if (
          !provider ||
          (typeof provider !== "object" && typeof provider !== "function")
        )
          throw new Error(
            `Provider ${name}: factory did not return a provider.`,
          );
      }
    }
    providers.set(name, provider);
  }
  return (model: ModelConfig) => {
    const provider = providers.get(model.provider);
    if (model.mode === "evaluation") {
      if (typeof provider?.evaluationModel !== "function")
        throw new Error(
          `Provider ${model.provider} does not support evaluation mode. Configure language mode for structured-output models.`,
        );
      return {
        mode: "evaluation" as const,
        model: provider.evaluationModel(model.model),
      };
    }
    if (typeof provider?.languageModel !== "function")
      throw new Error(
        `Provider ${model.provider} does not support language mode.`,
      );
    return {
      mode: "language" as const,
      model: provider.languageModel(model.model),
    };
  };
}

export type ModelResolver = Awaited<ReturnType<typeof createModelResolver>>;

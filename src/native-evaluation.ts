import { experimental_evaluate as evaluate } from "ai";
import type { Experimental_EvaluationModel } from "ai";
import { Effect } from "effect";
import type { Config, ModelConfig } from "./config";
import type { EvaluationInput } from "./evaluation-schemas";
import { ProviderError } from "./errors";

export const evaluateNative = Effect.fn("evaluateNative")(function* ({
  state,
  questions,
  model,
  modelConfig,
  config,
}: {
  state: EvaluationInput["state"];
  questions: EvaluationInput["questions"];
  model: Experimental_EvaluationModel;
  modelConfig: ModelConfig;
  config: Config;
}) {
  return yield* Effect.tryPromise({
    try: (signal) => {
      return evaluate({
        model,
        state,
        questions,
        abortSignal: signal,
        maxRetries: config.maxRetries,
        providerOptions: modelConfig.providerOptions,
      });
    },
    catch: () => {
      return new ProviderError({ message: "Evaluation provider request failed." });
    },
  });
});

const ownProperty = (value: unknown, key: string): unknown => {
  return value !== null && typeof value === "object" && Object.hasOwn(value, key)
    ? Reflect.get(value, key)
    : undefined;
};

export function nativeConfidence({
  metadata,
  id,
}: {
  metadata: unknown;
  id: string;
}): number | null {
  const value = ownProperty(ownProperty(ownProperty(metadata, "typesafe"), "confidence"), id);

  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

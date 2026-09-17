import { generateText, Output } from "ai";
import type { LanguageModel as SdkLanguageModel, ModelMessage } from "ai";
import { Effect, Layer, Ref, Schema, Stream } from "effect";
import { Agent, AgentRuntime, InMemory } from "effect-agent";
import { AiError, LanguageModel, Model, Toolkit } from "effect/unstable/ai";
import type { Prompt, Response } from "effect/unstable/ai";
import type { Config, ModelConfig } from "./config.js";
import { DecisionError } from "./errors.js";
import { decisionSchema, estimatesSchema } from "./schemas.js";
import type { Decision } from "./schemas.js";

// This is deliberately a text-only, tool-free adapter for the decision agent.
// Reject unsupported prompt parts instead of silently dropping their meaning.
const toMessages = (prompt: Prompt.Prompt): ModelMessage[] =>
  prompt.content.map((message) => {
    if (message.role === "system")
      return { role: "system", content: message.content };
    if (
      message.role === "tool" ||
      message.content.some((part) => part.type !== "text")
    )
      throw new Error("Unsupported decision-agent prompt");
    return {
      role: message.role,
      content: message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join(""),
    };
  });

export const runLanguageAgent = Effect.fn("runLanguageAgent")(function* ({
  input,
  model,
  modelConfig,
  config,
  policy,
}: {
  input: Decision;
  model: SdkLanguageModel;
  modelConfig: ModelConfig;
  config: Config;
  policy: string;
}) {
  const warnings = yield* Ref.make(false);
  const generate = (options: LanguageModel.ProviderOptions) =>
    Effect.tryPromise({
      try: (signal) =>
        generateText({
          model,
          system: options.prompt.content
            .filter((message) => message.role === "system")
            .map((message) => message.content)
            .join("\n\n"),
          messages: toMessages(options.prompt).filter(
            (message) => message.role !== "system",
          ),
          output: Output.object({
            schema: Schema.toStandardSchemaV1(
              Schema.toStandardJSONSchemaV1(estimatesSchema),
            ),
          }),
          abortSignal: signal,
          maxRetries: config.maxRetries,
          providerOptions: modelConfig.providerOptions,
        }),
      catch: () =>
        AiError.make({
          module: "decide-mcp",
          method: "generateText",
          reason: new AiError.UnknownError({
            description: "Language provider request failed.",
          }),
        }),
    }).pipe(
      Effect.tap((result) =>
        Ref.set(warnings, Boolean(result.warnings?.length)),
      ),
    );
  const modelLayer = Model.make(
    modelConfig.provider,
    modelConfig.model,
    Layer.effect(
      LanguageModel.LanguageModel,
      LanguageModel.make({
        generateText: (options) =>
          generate(options).pipe(
            Effect.map((result): Response.PartEncoded[] => [
              { type: "text", text: JSON.stringify(result.output) },
            ]),
          ),
        // AI SDK structured output is buffered, then exposed as Effect response parts.
        // The SDK owns transport retries; the agent never retries a failed decision.
        streamText: (options) =>
          Stream.unwrap(
            generate(options).pipe(
              Effect.map((result) =>
                Stream.fromIterable<Response.StreamPartEncoded>([
                  { type: "text-start", id: "decision" },
                  {
                    type: "text-delta",
                    id: "decision",
                    delta: JSON.stringify(result.output),
                  },
                  { type: "text-end", id: "decision" },
                  {
                    type: "finish",
                    reason: result.finishReason,
                    usage: {
                      inputTokens: { total: result.usage.inputTokens },
                      outputTokens: { total: result.usage.outputTokens },
                    },
                  },
                ]),
              ),
            ),
          ),
      }),
    ),
  );
  const agent = Agent.make("decision-estimator", {
    input: decisionSchema,
    output: estimatesSchema,
    instructions: `${policy}\nEstimate a probability for every choice being the best option. Return each ID exactly once; probabilities must sum to 1. These are estimates, not calibrated confidence.`,
    toolkit: Toolkit.empty,
    policy: {
      maxTurns: 1,
      maxToolCalls: 1,
      maxDuration: config.timeoutMs,
      onExhaustion: "fail",
    },
  });
  const result = yield* AgentRuntime.run(agent, input).pipe(
    Effect.provide(modelLayer),
    // A fresh history scope for each request prevents context crossing decisions.
    Effect.provide(InMemory.layer),
    Effect.mapError(
      () => new DecisionError({ message: "Language decision agent failed." }),
    ),
  );
  return {
    estimates: result.output.choices,
    hasWarnings: yield* Ref.get(warnings),
  };
});

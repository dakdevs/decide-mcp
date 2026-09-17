import { Effect, Schema } from "effect";
import { McpSchema, Tool } from "effect/unstable/ai";
import { evaluateDescription } from "./agent-guidance";
import type { Config } from "./config";
import { createDecisionService } from "./decision-service";
import { evaluationInputSchema, evaluationResultSchema } from "./evaluation-schemas";
import type { Evaluator } from "./evaluation-service";
import { decisionSchema, resultSchema } from "./schemas";
import type { Scorer } from "./scoring";

const toolSchema = (schema: Schema.Top) => {
  return Schema.decodeUnknownEffect(McpSchema.ToolJsonSchema)(Tool.getJsonSchemaFromSchema(schema));
};

export const createTools = Effect.fn("createTools")(function* ({
  config,
  score,
  evaluate,
}: {
  config: Config;
  score: Scorer;
  evaluate: Evaluator;
}) {
  const inputSchema = yield* toolSchema(decisionSchema);

  const outputSchema = yield* toolSchema(resultSchema);

  const decide = createDecisionService({ config, score });

  const decisions = [
    {
      name: "decide",
      description:
        "Evaluate a decision, context, and choices. Returns a recommendation, choice percentages, and separate provider confidence when available. Automatically selects a configured bias profile when routing is enabled. Percentages are not guarantees. The calling agent retains responsibility for acting.",
      profileId: undefined,
    },
    ...(config.tools === "routed"
      ? []
      : [
          {
            name: "decide-default",
            description:
              "Evaluate with only the default policy, bypassing automatic profile selection.",
            profileId: "default",
          },
          ...config.profiles.map((profile) => {
            return {
              name: `decide-${profile.id}`,
              description: `Evaluate using the ${profile.id} profile. ${profile.description}`,
              profileId: profile.id,
            };
          }),
        ]),
  ];

  const definitions: Array<{
    name: string;
    description: string;
    inputSchema: typeof inputSchema;
    outputSchema: typeof outputSchema;
    execute: (input: unknown) => Effect.Effect<Record<string, unknown>, unknown>;
  }> = decisions.map(({ profileId, ...definition }) => {
    return {
      ...definition,
      inputSchema,
      outputSchema,
      execute: (input: unknown) => {
        return decide({ input, profileId });
      },
    };
  });

  definitions.push({
    name: "evaluate",
    description: `${evaluateDescription} Available profiles: default (global policy)${config.profiles
      .map((profile) => {
        return `; ${profile.id}: ${profile.description}`;
      })
      .join("")}.`,
    inputSchema: yield* toolSchema(evaluationInputSchema),
    outputSchema: yield* toolSchema(evaluationResultSchema),
    execute: evaluate,
  });

  return definitions;
});

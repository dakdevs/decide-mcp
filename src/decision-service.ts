import { Effect, Schema } from "effect";
import { DecisionError } from "./errors.js";
import type { Config } from "./config.js";
import { decisionSchema, resultSchema } from "./schemas.js";
import type { DecisionResult } from "./schemas.js";
import type { Scorer } from "./scoring.js";

export function createDecisionService({
  config,
  score,
}: {
  config: Config;
  score: Scorer;
}) {
  return ({ input, profileId }: { input: unknown; profileId?: string }) =>
    Effect.gen(function* () {
      const parsed = yield* Schema.decodeUnknownEffect(decisionSchema, {
        onExcessProperty: "error",
      })(input);
      let selectedProfile = profileId ?? "default";
      let routing: DecisionResult["routing"] = {
        mode: profileId ? "explicit" : "default",
        selectedProfile,
      };
      if (
        profileId &&
        profileId !== "default" &&
        !config.profiles.some((profile) => profile.id === profileId)
      )
        return yield* new DecisionError({ message: "Unknown profile." });
      if (!profileId && config.profiles.length && config.tools !== "separate") {
        const route = yield* score({
          input: {
            decision:
              "Which configured decision profile is most appropriate for this request?",
            context: parsed,
            choices: [
              {
                id: "default",
                description:
                  "General-purpose decision policy; use when no specialized profile clearly applies.",
              },
              ...config.profiles.map((profile) => ({
                id: profile.id,
                description: profile.description,
              })),
            ],
          },
          model: config.router.model ?? config.model,
          systemPrompt: config.router.systemPrompt,
        });
        const percentage =
          route.choices.find((choice) => choice.id === route.selectedChoice)
            ?.percentage ?? null;
        const fallback =
          config.router.minimumProbability > 0 &&
          (percentage === null ||
            percentage / 100 < config.router.minimumProbability);
        selectedProfile = fallback ? "default" : route.selectedChoice;
        routing = {
          mode: "automatic",
          selectedProfile,
          proposedProfile: route.selectedChoice,
          selectedPercentage: percentage,
          percentageSource: route.percentageSource,
          fallback,
          model: route.model,
          provider: route.provider,
          warnings: route.warnings,
        };
      }
      const profile = config.profiles.find(
        (profile) => profile.id === selectedProfile,
      );
      if (selectedProfile !== "default" && !profile)
        return yield* new DecisionError({
          message: "Router returned an unknown profile.",
        });
      const result = yield* score({
        input: parsed,
        model: profile?.model ?? config.model,
        systemPrompt: [config.systemPrompt, profile?.systemPrompt]
          .filter(Boolean)
          .join("\n\nProfile policy:\n"),
      });
      return yield* Schema.decodeUnknownEffect(resultSchema)({
        ...result,
        profile: selectedProfile,
        routing,
      });
    }).pipe(Effect.timeout(config.timeoutMs));
}

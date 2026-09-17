import { Effect, Schema } from "effect";
import type { Config } from "./config";
import { DecisionError } from "./errors";
import { decisionSchema, resultSchema } from "./schemas";
import type { Decision, DecisionResult } from "./schemas";
import type { Scorer } from "./scoring";

function resolveRouting({
  config,
  score,
  input,
  profileId,
}: {
  config: Config;
  score: Scorer;
  input: Decision;
  profileId?: string;
}): Effect.Effect<DecisionResult["routing"], Effect.Error<ReturnType<Scorer>>> {
  return Effect.gen(function* () {
    if (profileId || config.profiles.length === 0 || config.tools === "separate") {
      return { mode: profileId ? "explicit" : "default", selectedProfile: profileId ?? "default" };
    }

    const route = yield* score({
      input: {
        decision: "Which configured decision profile is most appropriate for this request?",
        context: input,
        choices: [
          {
            id: "default",
            description:
              "General-purpose decision policy; use when no specialized profile clearly applies.",
          },
          ...config.profiles.map((profile) => {
            return { id: profile.id, description: profile.description };
          }),
        ],
      },
      model: config.router.model ?? config.model,
      systemPrompt: config.router.systemPrompt,
    });

    const percentage =
      route.choices.find((choice) => {
        return choice.id === route.selectedChoice;
      })?.percentage ?? null;

    const fallback =
      config.router.minimumProbability > 0 &&
      (percentage === null || percentage / 100 < config.router.minimumProbability);

    return {
      mode: "automatic",
      selectedProfile: fallback ? "default" : route.selectedChoice,
      proposedProfile: route.selectedChoice,
      selectedPercentage: percentage,
      percentageSource: route.percentageSource,
      fallback,
      model: route.model,
      provider: route.provider,
      warnings: route.warnings,
    };
  });
}

export function createDecisionService({ config, score }: { config: Config; score: Scorer }) {
  return ({ input, profileId }: { input: unknown; profileId?: string }) => {
    return Effect.gen(function* () {
      const parsed = yield* Schema.decodeUnknownEffect(decisionSchema, {
        onExcessProperty: "error",
      })(input);

      if (
        profileId &&
        profileId !== "default" &&
        !config.profiles.some((profile) => {
          return profile.id === profileId;
        })
      ) {
        return yield* new DecisionError({ message: "Unknown profile." });
      }

      const routing = yield* resolveRouting({ config, score, input: parsed, profileId });

      const profile = config.profiles.find((profile) => {
        return profile.id === routing.selectedProfile;
      });

      if (routing.selectedProfile !== "default" && !profile) {
        return yield* new DecisionError({ message: "Router returned an unknown profile." });
      }

      const result = yield* score({
        input: parsed,
        model: profile?.model ?? config.model,
        systemPrompt: [config.systemPrompt, profile?.systemPrompt]
          .filter(Boolean)
          .join("\n\nProfile policy:\n"),
      });

      return yield* Schema.decodeUnknownEffect(resultSchema)({
        ...result,
        profile: routing.selectedProfile,
        routing,
      });
    }).pipe(Effect.timeout(config.timeoutMs));
  };
}

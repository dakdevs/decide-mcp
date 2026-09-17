import type { Config } from "./config.js";
import { decisionSchema, resultSchema } from "./schemas.js";
import type { Decision } from "./schemas.js";
import type { Scorer } from "./scoring.js";

export function createDecisionService({
  config,
  score,
}: {
  config: Config;
  score: Scorer;
}) {
  return async ({
    input,
    profileId,
    signal,
  }: {
    input: Decision;
    profileId?: string;
    signal?: AbortSignal;
  }) => {
    const parsed = decisionSchema.parse(input);
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const abortSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    abortSignal.throwIfAborted();
    let selectedProfile = profileId ?? "default";
    let routing: ReturnType<typeof resultSchema.parse>["routing"] = {
      mode: profileId ? "explicit" : "default",
      selectedProfile,
    };
    if (
      profileId &&
      profileId !== "default" &&
      !config.profiles.some((profile) => profile.id === profileId)
    )
      throw new Error("Unknown profile.");
    if (!profileId && config.profiles.length && config.tools !== "separate") {
      const route = await score({
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
        signal: abortSignal,
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
    abortSignal.throwIfAborted();
    const profile = config.profiles.find(
      (profile) => profile.id === selectedProfile,
    );
    if (selectedProfile !== "default" && !profile)
      throw new Error("Router returned an unknown profile.");
    const result = await score({
      input: parsed,
      model: profile?.model ?? config.model,
      systemPrompt: [config.systemPrompt, profile?.systemPrompt]
        .filter(Boolean)
        .join("\n\nProfile policy:\n"),
      signal: abortSignal,
    });
    abortSignal.throwIfAborted();
    return resultSchema.parse({ ...result, profile: selectedProfile, routing });
  };
}

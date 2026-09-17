import { Data } from "effect";

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly message: string;
}> {}

export class ProviderError extends Data.TaggedError("ProviderError")<{
  readonly message: string;
}> {}

export class DecisionError extends Data.TaggedError("DecisionError")<{
  readonly message: string;
}> {}

export const decisionFailureMessage =
  "Decision failed: check provider credentials, model capability, configuration, and timeout. No recommendation was produced.";

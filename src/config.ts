import { dirname, resolve } from "node:path";
import { Effect, FileSystem, Schema } from "effect";
import { ConfigError } from "./errors";

const text = Schema.Trim.check(Schema.isMinLength(1));
const identifier = text.check(
  Schema.isMaxLength(48),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
);
const modelSchema = Schema.Struct({
  provider: text.pipe(Schema.withDecodingDefaultKey(Effect.succeed("gateway"))),
  model: text,
  mode: Schema.Literals(["evaluation", "language"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("evaluation" as const)),
  ),
  providerOptions: Schema.optionalKey(Schema.Record(Schema.String, Schema.JsonObject)),
});
export const providerSchema = Schema.Struct({
  kind: Schema.Literals([
    "gateway",
    "typesafe",
    "openai",
    "anthropic",
    "google",
    "openai-compatible",
    "custom",
  ]),
  apiKeyEnv: Schema.optionalKey(text),
  baseURL: Schema.optionalKey(
    Schema.String.check(
      Schema.makeFilter((value) => {
        return URL.canParse(value) || "Invalid URL";
      }),
    ),
  ),
  module: Schema.optionalKey(text),
  export: Schema.optionalKey(text),
  options: Schema.optionalKey(Schema.JsonObject),
}).check(
  Schema.makeFilter((value) => {
    if (value.kind === "openai-compatible" && !value.baseURL) {
      return "openai-compatible requires baseURL";
    }

    if (value.kind === "custom" && (!value.module || !value.export)) {
      return "custom requires module and export (a provider factory)";
    }

    if (value.kind !== "custom" && (value.module || value.export || value.options)) {
      return "module, export, and options are only supported for custom providers";
    }

    return true;
  }),
);
const routerPrompt =
  "Select the most relevant decision profile based on its purpose. Use default when no specialized profile clearly applies. Do not select a profile just to obtain a desired answer.";
export const configSchema = Schema.Struct({
  model: modelSchema.pipe(
    Schema.withDecodingDefaultKey(
      Effect.succeed({
        provider: "gateway",
        model: "typesafe-ai/jev",
        mode: "evaluation" as const,
      }),
    ),
  ),
  systemPrompt: text
    .check(Schema.isMaxLength(16000))
    .pipe(
      Schema.withDecodingDefaultKey(
        Effect.succeed(
          "Choose the option best supported by the supplied context. Consider uncertainty and tradeoffs.",
        ),
      ),
    ),
  providers: Schema.Record(identifier, providerSchema).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({ gateway: { kind: "gateway" as const } })),
  ),
  profiles: Schema.Array(
    Schema.Struct({
      id: identifier.check(
        Schema.makeFilter((id) => {
          return id !== "default" || "default is reserved";
        }),
      ),
      description: text.check(Schema.isMaxLength(2000)),
      systemPrompt: text.check(Schema.isMaxLength(16000)),
      model: Schema.optionalKey(modelSchema),
    }),
  )
    .check(Schema.isMaxLength(32))
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  tools: Schema.Literals(["routed", "separate", "both"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("routed" as const)),
  ),
  router: Schema.Struct({
    model: Schema.optionalKey(modelSchema),
    systemPrompt: text
      .check(Schema.isMaxLength(16000))
      .pipe(Schema.withDecodingDefaultKey(Effect.succeed(routerPrompt))),
    minimumProbability: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed(0)),
    ),
  }).pipe(
    Schema.withDecodingDefaultKey(
      Effect.succeed({ systemPrompt: routerPrompt, minimumProbability: 0 }),
    ),
  ),
  timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 300000 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(30000)),
  ),
  maxRetries: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(2)),
  ),
}).check(
  Schema.makeFilter((config) => {
    const ids = config.profiles.map((profile) => {
      return profile.id;
    });

    if (new Set(ids).size !== ids.length) {
      return "Profile IDs must be unique";
    }

    for (const model of [
      config.model,
      config.router.model,
      ...config.profiles.map((profile) => {
        return profile.model;
      }),
    ]) {
      if (model && !Object.hasOwn(config.providers, model.provider)) {
        return `Unknown provider: ${model.provider}`;
      }
    }

    return true;
  }),
);
export type Config = typeof configSchema.Type;
export type ModelConfig = typeof modelSchema.Type;
export const loadConfig = Effect.fn("loadConfig")(function* ({
  path,
  json,
}: {
  path?: string;
  json?: string;
}) {
  if (path && json) {
    return yield* new ConfigError({
      message: "Use either --config / DECIDE_CONFIG or DECIDE_CONFIG_JSON, not both.",
    });
  }

  const contents = path
    ? yield* (yield* FileSystem.FileSystem).readFileString(resolve(path))
    : json;

  const raw = contents
    ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(contents)
    : {};

  const config = yield* Schema.decodeUnknownEffect(configSchema, {
    onExcessProperty: "error",
  })(raw);

  return {
    config,
    baseDirectory: path ? dirname(resolve(path)) : process.cwd(),
  };
});

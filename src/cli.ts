#!/usr/bin/env node
import { parseArgs } from "node:util";
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Cause, Console, Effect, Layer, Logger } from "effect";
import { ConfigError } from "./errors";
import { loadConfig } from "./config";
import { createModelResolver } from "./providers";
import { createScorer } from "./scoring";
import { runServer } from "./server";

const main = Effect.gen(function* () {
  // SDK warnings may include provider-supplied text. Return only sanitized warnings.
  yield* Effect.sync(() => {
    globalThis.AI_SDK_LOG_WARNINGS = false;
  });

  const { values } = yield* Effect.try(() => {
    return parseArgs({
      options: {
        config: { type: "string" },
        help: { type: "boolean" },
        version: { type: "boolean" },
      },
    });
  });

  if (values.help) {
    return yield* Console.log(
      "decide-mcp [--config /absolute/path/decide.config.json]\nConfiguration: --config, DECIDE_CONFIG, or DECIDE_CONFIG_JSON.\nWithout configuration: Jev via AI Gateway (AI_GATEWAY_API_KEY).\nTransport: MCP over stdio.",
    );
  }

  if (values.version) {
    return yield* Console.log("0.1.0");
  }

  const { config, baseDirectory } = yield* loadConfig({
    path: values.config ?? process.env.DECIDE_CONFIG,
    json: process.env.DECIDE_CONFIG_JSON,
  });

  const resolveModel = yield* createModelResolver({ config, baseDirectory });

  yield* Effect.forEach(
    [
      config.model,
      config.router.model,
      ...config.profiles.map((profile) => {
        return profile.model;
      }),
    ].filter((model) => {
      return model !== undefined;
    }),
    resolveModel,
  );

  yield* runServer({ config, score: createScorer({ config, resolveModel }) });
});

main.pipe(
  Effect.scoped,
  Effect.provide(NodeFileSystem.layer),
  Effect.provide(Layer.succeed(Logger.LogToStderr, true)),
  Effect.catchCause((cause) => {
    return Cause.hasInterrupts(cause)
      ? Effect.failCause(cause)
      : Console.error(
          "decide-mcp could not start. Check configuration syntax, provider factories, and required credential environment variables.",
        ).pipe(Effect.andThen(Effect.fail(new ConfigError({ message: "MCP startup failed." }))));
  }),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);

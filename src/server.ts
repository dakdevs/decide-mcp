import { Server } from "#mcp/server/index";
import { StdioServerTransport } from "#mcp/server/stdio";
import { CallToolRequestSchema, ListToolsRequestSchema } from "#mcp/types";
import { Cause, Deferred, Effect, FiberSet, Schema } from "effect";
import { McpSchema, Tool } from "effect/unstable/ai";
import type { Config } from "./config";
import { createDecisionService } from "./decision-service";
import { ConfigError, DecisionError, decisionFailureMessage } from "./errors";
import { decisionSchema, resultSchema } from "./schemas";
import type { Scorer } from "./scoring";

// Keep the SDK only at the wire boundary. Effect rc.115's native MCP server
// stringifies numeric cancellation IDs, preventing it from interrupting SDK clients.
// A scoped FiberSet owns every callback fiber, including shutdown interruption.
export const runServer = Effect.fn("runServer")(function* ({
  config,
  score,
}: {
  config: Config;
  score: Scorer;
}) {
  const runRequest = yield* FiberSet.makeRuntimePromise();

  const closed = yield* Deferred.make<void>();

  const onClose = () => {
    Deferred.doneUnsafe(closed, Effect.void);
  };
  // The SDK transport does not emit onclose for stdin EOF. Release the scope
  // on EOF as well, so disconnected clients do not leave provider fibers alive.

  yield* Effect.acquireRelease(
    Effect.sync(() => {
      process.stdin.once("end", onClose);

      if (process.stdin.readableEnded) {
        onClose();
      }
    }),
    () => {
      return Effect.sync(() => {
        process.stdin.off("end", onClose);
      });
    },
  );

  const server = yield* Effect.acquireRelease(
    Effect.sync(() => {
      return new Server({ name: "decide-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });
    }),
    (server) => {
      return Effect.promise(() => {
        return server.close();
      }).pipe(Effect.ignoreCause);
    },
  );

  const inputSchema = yield* Schema.decodeUnknownEffect(McpSchema.ToolJsonSchema)(
    Tool.getJsonSchemaFromSchema(decisionSchema),
  );

  const outputSchema = yield* Schema.decodeUnknownEffect(McpSchema.ToolJsonSchema)(
    Tool.getJsonSchemaFromSchema(resultSchema),
  );

  const definitions: ReadonlyArray<{
    name: string;
    description: string;
    profileId?: string;
  }> = [
    {
      name: "decide",
      description:
        "Evaluate a decision, context, and choices. Returns a recommendation and percentages with their source. Automatically selects a configured bias profile when routing is enabled. Percentages are not guarantees. The calling agent retains responsibility for acting.",
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

  const decide = createDecisionService({ config, score });

  yield* Effect.sync(() => {
    server.onclose = onClose;

    server.setRequestHandler(ListToolsRequestSchema, () => {
      return runRequest(
        Effect.succeed({
          tools: definitions.map(({ name, description }) => {
            return {
              name,
              description,
              inputSchema,
              outputSchema,
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: true,
              },
            };
          }),
        }),
      );
    });

    server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
      return runRequest(
        Effect.suspend(() => {
          if (extra.signal.aborted) {
            return Effect.interrupt;
          }

          const definition = definitions.find((tool) => {
            return tool.name === request.params.name;
          });

          return definition
            ? decide({
                input: request.params.arguments,
                profileId: definition.profileId,
              })
            : Effect.fail(new DecisionError({ message: "Unknown tool." }));
        }).pipe(
          Effect.map((result) => {
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
              structuredContent: result,
            };
          }),
          // Never log or return provider causes, which can contain credentials or context.
          Effect.catchCause((cause) => {
            return Cause.hasInterrupts(cause)
              ? Effect.interrupt
              : Effect.succeed({
                  isError: true,
                  content: [{ type: "text" as const, text: decisionFailureMessage }],
                });
          }),
        ),
        { signal: extra.signal },
      );
    });
  });

  yield* Effect.tryPromise({
    try: () => {
      return server.connect(new StdioServerTransport());
    },
    catch: () => {
      return new ConfigError({ message: "Could not connect MCP stdio transport." });
    },
  });

  yield* Deferred.await(closed);
});

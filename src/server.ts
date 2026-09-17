import { Server } from "#mcp/server/index";
import { StdioServerTransport } from "#mcp/server/stdio";
import { CallToolRequestSchema, ListToolsRequestSchema } from "#mcp/types";
import { Cause, Deferred, Effect, FiberSet } from "effect";
import { agentInstructions } from "./agent-guidance";
import { createTools } from "./tools";
import type { Evaluator } from "./evaluation-service";
import type { Config } from "./config";
import { ConfigError, DecisionError, decisionFailureMessage } from "./errors";
import type { Scorer } from "./scoring";

// Keep the SDK only at the wire boundary. Effect rc.115's native MCP server
// stringifies numeric cancellation IDs, preventing it from interrupting SDK clients.
// A scoped FiberSet owns every callback fiber, including shutdown interruption.
export const runServer = Effect.fn("runServer")(function* ({
  config,
  score,
  evaluate,
}: {
  config: Config;
  score: Scorer;
  evaluate: Evaluator;
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
      return new Server(
        { name: "decide-mcp", version: "0.1.0" },
        { capabilities: { tools: {} }, instructions: agentInstructions },
      );
    }),
    (server) => {
      return Effect.promise(() => {
        return server.close();
      }).pipe(Effect.ignoreCause);
    },
  );

  const definitions = yield* createTools({ config, score, evaluate });

  yield* Effect.sync(() => {
    server.onclose = onClose;

    server.setRequestHandler(ListToolsRequestSchema, () => {
      return runRequest(
        Effect.succeed({
          tools: definitions.map(({ name, description, inputSchema, outputSchema }) => {
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
            ? definition.execute(request.params.arguments)
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

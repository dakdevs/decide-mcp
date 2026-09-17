import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { createDecisionService } from "./decision-service.js";
import { decisionSchema, resultSchema } from "./schemas.js";
import type { Scorer } from "./scoring.js";

export function createServer({
  config,
  score,
}: {
  config: Config;
  score: Scorer;
}) {
  const server = new McpServer({ name: "decide-mcp", version: "0.1.0" });
  const decide = createDecisionService({ config, score });
  const register = ({
    name,
    description,
    profileId,
  }: {
    name: string;
    description: string;
    profileId?: string;
  }) => {
    server.registerTool(
      name,
      {
        description,
        inputSchema: decisionSchema,
        outputSchema: resultSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (input, extra) => {
        try {
          const result = await decide({
            input,
            profileId,
            signal: extra.signal,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch {
          // Provider exceptions can include request data, authorization headers, or response bodies.
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Decision failed: check provider credentials, model capability, configuration, and timeout. No recommendation was produced.",
              },
            ],
          };
        }
      },
    );
  };
  register({
    name: "decide",
    description:
      "Evaluate a decision, context, and choices. Returns a recommendation and percentages with their source. Automatically selects a configured bias profile when routing is enabled. Percentages are not guarantees. The calling agent retains responsibility for acting.",
  });
  if (config.tools !== "routed") {
    register({
      name: "decide-default",
      description:
        "Evaluate with only the default policy, bypassing automatic profile selection.",
      profileId: "default",
    });
    for (const profile of config.profiles)
      register({
        name: `decide-${profile.id}`,
        description: `Evaluate using the ${profile.id} profile. ${profile.description}`,
        profileId: profile.id,
      });
  }
  return server;
}

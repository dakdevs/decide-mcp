#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createModelResolver } from "./providers.js";
import { createScorer } from "./scoring.js";
import { createServer } from "./server.js";

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      help: { type: "boolean" },
      version: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "decide-mcp [--config /absolute/path/decide.config.json]\nConfiguration: --config, DECIDE_CONFIG, or DECIDE_CONFIG_JSON.\nWithout configuration: Jev via AI Gateway (AI_GATEWAY_API_KEY).\nTransport: MCP over stdio.",
    );
    return;
  }
  if (values.version) {
    console.log("0.1.0");
    return;
  }
  const { config, baseDirectory } = await loadConfig({
    path: values.config ?? process.env.DECIDE_CONFIG,
    json: process.env.DECIDE_CONFIG_JSON,
  });
  const resolveModel = await createModelResolver({ config, baseDirectory });
  // Fail early on unsupported factories or unknown model capabilities.
  for (const model of [
    config.model,
    config.router.model,
    ...config.profiles.map((profile) => profile.model),
  ])
    if (model) resolveModel(model);
  const server = createServer({
    config,
    score: createScorer({ config, resolveModel }),
  });
  await server.connect(new StdioServerTransport());
  const close = async () => {
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

main().catch(() => {
  console.error(
    "decide-mcp could not start. Check configuration syntax, provider factories, and required credential environment variables.",
  );
  process.exitCode = 1;
});

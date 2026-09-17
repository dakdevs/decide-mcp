# decide-mcp

A local MCP server that lets an agent delegate a decision to a configurable model. Send a decision, context, and choices; receive a recommended choice and percentages. The agent decides what to do next.

Defaults to **TypeSafe AI Jev through AI Gateway**, using AI SDK 7's `experimental_evaluate`. Supports custom decision policies, multiple bias profiles, automatic profile routing, and individual tools per profile.

## Install

Requires Node.js 22.19+. Add this to an MCP client that supports stdio:

```json
{
  "mcpServers": {
    "decide": {
      "command": "npx",
      "args": ["-y", "decide-mcp@0.1.0"],
      "env": { "AI_GATEWAY_API_KEY": "your-gateway-key" }
    }
  }
}
```

Or install globally with `npm install -g decide-mcp` and use `decide-mcp` as the command. The published package includes the built CLI; users do not need Bun.

## Develop locally

Requires Bun for development and Node.js 22.19+ to run the built server.

```sh
bun install --frozen-lockfile
bun run build
```

Add this to an MCP client that supports stdio, replacing the path and credential with your own values:

```json
{
  "mcpServers": {
    "decide": {
      "command": "node",
      "args": ["/absolute/path/decide-mcp/dist/cli.js"],
      "env": { "AI_GATEWAY_API_KEY": "your-gateway-key" }
    }
  }
}
```

The default needs no configuration file. It uses `typesafe-ai/jev`. This package runs locally; it is not a hosted MCP endpoint. Agents without stdio MCP support need a separate transport integration.

For configuration, add `"--config", "/absolute/path/decide.config.json"` to `args`. Alternatively, set `DECIDE_CONFIG` to a file path or `DECIDE_CONFIG_JSON` to inline JSON in the MCP client's environment. File and inline configuration cannot be combined. Relative custom provider modules resolve from the configuration file's directory; inline configuration uses the process working directory.

The server reads environment variables from its MCP process. It does not automatically load `.env` files. Credentials stay in environment variables; configuration uses names such as `apiKeyEnv` rather than secret values.

## Tool contract

Call `decide`:

```json
{
  "decision": "Should we release this change now?",
  "context": {
    "tests": "passing",
    "rollback": "available",
    "risk": "Touches a critical payment path; production traffic is currently high."
  },
  "choices": [
    { "id": "ship", "description": "Release immediately" },
    { "id": "wait", "description": "Wait for a lower-traffic window" }
  ]
}
```

Illustrative response (actual scores depend on the model):

```json
{
  "selectedChoice": "wait",
  "choices": [
    { "id": "ship", "percentage": 22 },
    { "id": "wait", "percentage": 78 }
  ],
  "percentageSource": "provider-distribution",
  "model": "typesafe-ai/jev",
  "provider": "gateway",
  "warnings": [],
  "profile": "default",
  "routing": { "mode": "default", "selectedProfile": "default" }
}
```

Results are returned as both MCP `structuredContent` and JSON text for client compatibility. Choice IDs must be unique. Supply 2–64 mutually exclusive choices. Context can be a string, JSON object, or JSON array, up to 100,000 serialized characters.

### What the percentages mean

| Source                  | Meaning                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `provider-distribution` | The evaluation provider's choice probabilities multiplied by 100. No normalization or invented probabilities.                   |
| `model-estimate`        | A language model's requested probability estimates, validated for coverage, range, and a sum of one. Not calibrated confidence. |
| `unavailable`           | An evaluation model returned a choice without a distribution. Every percentage is `null`, with a warning.                       |

Jev's separate confidence statistic is **not** a selected-choice probability and is not substituted for one. Rounded native distributions may sum to 99% or 101%; their values are preserved. Estimates are validated, not silently normalized. Tied estimates use input order as the tie-breaker.

## Decision policies and profiles

`systemPrompt` configures the global decision policy. A named profile adds its policy to the global policy and can optionally use a different model or provider. With native evaluation models, the policy goes into the question's `instructions`; the experimental API has no separate system-message parameter. In language mode it is a system message.

See [multiple-profiles.json](examples/multiple-profiles.json) for a complete Jev configuration:

```json
{
  "systemPrompt": "Prefer reversible actions and respect the stated constraints.",
  "tools": "both",
  "router": { "minimumProbability": 0.7 },
  "profiles": [
    {
      "id": "reliability",
      "description": "Releases, operational risk, and service reliability.",
      "systemPrompt": "Favor reliability and safe rollback over speed."
    },
    {
      "id": "cost",
      "description": "Purchasing, sizing, and resource allocation.",
      "systemPrompt": "Minimize total cost while meeting the requirements."
    }
  ]
}
```

| `tools`            | Exposed tools                                     | Behavior of `decide`                                                   |
| ------------------ | ------------------------------------------------- | ---------------------------------------------------------------------- |
| `routed` (default) | `decide`                                          | Chooses a profile, then evaluates the decision.                        |
| `separate`         | `decide`, `decide-default`, `decide-<profile-id>` | Uses the default policy. The calling agent chooses a specialized tool. |
| `both`             | All of the above                                  | Routes automatically; explicit tools bypass routing.                   |

With no profiles, `decide` makes one model call. With profiles and routing enabled, it makes two: one to select a profile from its description, one to evaluate with that policy. Explicit tools always make one call. Profiles do not vote or blend scores.

This is a **two-stage decision tree**. A single router keeps latency bounded and makes policy selection observable. Recursive trees are not implemented. If profiles become numerous enough to need a hierarchy, that can be added as an explicit configuration structure.

`router.model` can override the default model. `router.systemPrompt` controls profile selection separately from the decision policies. `router.minimumProbability` is in `[0, 1]` and defaults to `0`, meaning no threshold. A positive threshold falls back to `default` if the proposed profile's probability is too low or unavailable. Router errors fail the request; they do not silently switch policies. This threshold uses the router's stated probability source and is not a calibration guarantee.

The result reports the selected profile, proposed profile, routing percentage/source, model/provider, and whether a threshold fallback occurred. `decide-default` provides an explicit bypass when separate tools are enabled.

## Providers

AI SDK packages and the lockfile are pinned because the experimental evaluation API may change in patch releases.

| Provider kind       | Default credential variable                     | Model modes                                      |
| ------------------- | ----------------------------------------------- | ------------------------------------------------ |
| `gateway`           | `AI_GATEWAY_API_KEY` (or supported Vercel OIDC) | `evaluation`, `language`, depending on the model |
| `typesafe`          | `TYPESAFE_AI_API_KEY`                           | `evaluation`                                     |
| `openai`            | `OPENAI_API_KEY`                                | `evaluation`, `language`                         |
| `anthropic`         | `ANTHROPIC_API_KEY`                             | `evaluation`, `language`                         |
| `google`            | `GOOGLE_GENERATIVE_AI_API_KEY`                  | `evaluation`, `language`                         |
| `openai-compatible` | Set `apiKeyEnv` if required                     | `language`; requires `baseURL`                   |
| `custom`            | Set `apiKeyEnv` or use the factory's defaults   | Whatever the installed AI SDK provider supports  |

Provider names are configuration aliases: multiple entries may use the same provider kind with different endpoints or credentials. The `providers` object replaces the default provider map when supplied. All model references must point to a configured alias. Models default to `mode: "evaluation"`; **set `mode: "language"` for general structured-output models when you need estimated percentages**. The SDK's OpenAI/Anthropic/Google evaluation adapters return choices without distributions, so evaluation mode on those adapters reports percentages as unavailable.

Use the real model ID supported by your provider and account. A language model must support structured output compatible with `Output.object`. Provider-specific settings can be passed in `model.providerOptions`; they are not universally portable.

### Direct Jev

[jev-direct.json](examples/jev-direct.json) calls TypeSafe directly without Gateway. Its model ID is `jev-latest`, with the AI SDK provider's `TYPESAFE_AI_API_KEY` variable. This differs from the standalone TypeSafe SDK's credential name. You can use another environment variable by setting `apiKeyEnv`.

### Language models

[language-provider.json](examples/language-provider.json) configures a direct OpenAI language model. The same pattern works for Anthropic and Google with their provider kinds and model IDs. A profile can override the global model:

```json
{
  "id": "complex",
  "description": "Decisions involving several interacting technical tradeoffs.",
  "systemPrompt": "Consider long-term maintenance and opportunity cost.",
  "model": { "provider": "openai", "model": "gpt-5.6-luna", "mode": "language" }
}
```

Add the referenced provider to your top-level `providers` map. Routing can continue to use Jev while the selected profile uses another model.

### Other AI SDK providers

Install the provider package locally. Set `kind: "custom"`, `module` to its package name or local module path, and `export` to its provider factory. See [custom-provider.json](examples/custom-provider.json), a working factory configuration using the included OpenAI package. Pass factory settings through `options`; `apiKeyEnv` and `baseURL` override their corresponding settings when supplied.

The factory must return an AI SDK provider with `languageModel(id)` or `evaluationModel(id)`. No packages are automatically downloaded at runtime. Local custom modules are trusted executable code, configured by the operator, never supplied through tool calls.

## Runtime and verification

The server uses functional Effect v4 for configuration decoding, provider resolution, decision scoring, shared request deadlines, and MCP request and transport lifetimes. Domain schemas use Effect Schema; typed failures stay in the Effect error channel. Promises are confined to AI SDK, custom-provider, and MCP transport integration boundaries. A scoped Effect FiberSet owns MCP request fibers and interrupts them during shutdown. The MCP TypeScript SDK remains the wire adapter: Effect rc.115's native MCP server converts numeric cancellation IDs to strings, so it cannot cancel numeric-ID requests from SDK clients. An E2E regression verifies cancellation through the retained adapter.

Language-mode scoring runs a tool-free `effect-agent` agent with a schema-validated output, one model turn, and a fresh in-memory history scope per call. An application-specific Effect language-model adapter keeps all existing AI SDK providers, credential settings, structured output, and retry behavior. The adapter buffers the structured response before exposing it as Effect stream parts. Native Jev evaluation continues to use `experimental_evaluate`, preserving provider distributions rather than converting them into generated estimates.

This migration pins `effect` and `@effect/platform-node` to `4.0.0-rc.115` and `effect-agent` to `0.1.0-beta.103`. These are prereleases. Node.js 22.19 or newer is required by the platform dependency. As of September 17, 2026, the newest published `effect-agent` release is on the `beta` tag; its peer dependency requires this Effect v4 release candidate. The npm `latest` tag still points to the older `0.0.1-beta.3`, so use the pinned versions and lockfile when developing.

`timeoutMs` defaults to 30,000 and covers routing, retries, and evaluation together. `maxRetries` defaults to 2 for transient provider failures. Client cancellation propagates to provider requests. Invalid inputs fail before model calls. Provider failures and invalid model output return an MCP tool error with no recommendation; raw provider exception details are not returned because they may contain sensitive request data.

Each request is independent. There is no conversation memory, persistence, action execution, or cross-request policy mutation. Decision data is sent to the configured provider. Configured prompts guide model behavior; they are not a security boundary against prompt injection.

Development source, test fixtures, and tool configurations are TypeScript. Imports omit file extensions, with TypeScript using bundler resolution to match the Bun build. The `#mcp/*` package import map handles the MCP SDK's extension-required export paths while keeping source imports extensionless.

Linting uses Oxlint with the `recommended` and `testing` presets from [`@dakdevs/oxlint-plugin/config`](https://github.com/dakdevs/oxlint-plugin), plus consistent type imports and extensionless imports. The shared config is pinned to a Git commit and its supported Oxlint 1.80 release. Formatting uses Oxfmt.

```sh
bun run lint
bun run fmt
bun run format:check
bun run typecheck
bun test
bun run test:e2e
```

Unit tests cover schemas, scoring semantics, routing thresholds, provider interruption, a shared deadline using Effect TestClock, concurrent language-agent isolation, bounded agent execution, and custom factories. E2E tests launch the built Node CLI through the actual MCP stdio client and use local HTTP provider fixtures with real AI SDK adapters. They cover native TypeSafe/Gateway transport, language estimates, tool discovery, routing, validation, timeout, client cancellation, malformed responses, startup failures, and error redaction. A package test packs the release, installs it in a temporary directory using npm, and verifies its executable and MCP handshake without relying on workspace dependencies. That test needs npm registry access. These checks do not establish real model quality or live provider access; live calls require an operator-provided API key.

## Release

Run the verification commands above, then `npm publish --access public`. The `prepack` hook builds the CLI before packing or publishing. Keep `package.json`, the CLI version, and the pinned installation example aligned when changing the version.

Licensed under the [MIT license](license.md).

## API references

- [AI SDK evaluation](https://ai-sdk.dev/docs/ai-sdk-core/evaluation)
- [AI SDK provider management](https://ai-sdk.dev/docs/ai-sdk-core/provider-management)
- [Jev on AI Gateway](https://vercel.com/ai-gateway/models/jev)
- [TypeSafe AI SDK](https://github.com/typesafe-ai/typesafe-sdk-js)
- [Effect v4 documentation](https://effect.website/v4/)
- [effect-agent](https://github.com/danieljvdm/effect-agent)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x)

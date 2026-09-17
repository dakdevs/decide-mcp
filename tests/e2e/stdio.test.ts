import { Schema } from "effect";
import { beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { Client } from "#mcp/client/index";
import { StdioClientTransport } from "#mcp/client/stdio";
import { evaluationResultSchema } from "../../src/evaluation-schemas";
import { resultSchema } from "../../src/schemas";
const input = {
  decision: "Release now?",
  context: { tests: "passing", rollback: "available" },
  choices: [
    { id: "ship", description: "Release" },
    { id: "wait", description: "Wait" },
  ],
};
const profiles = [
  {
    id: "safety",
    description: "Release safety",
    systemPrompt: "Prefer reversible changes.",
  },
];
beforeAll(() => {
  const build = spawnSync("bun", ["run", "build"], {
    cwd: resolve(import.meta.dir, "../.."),
    encoding: "utf8",
  });

  if (build.status !== 0) {
    throw new Error(build.stderr);
  }
});
async function withServer({
  config = {},
  handler,
  run,
}: {
  config?: Record<string, unknown>;
  handler: (request: Request) => Response | Promise<Response>;
  run: (client: Client) => Promise<void>;
}) {
  const api = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });

  const client = new Client({ name: "decide-e2e", version: "1.0.0" });

  const transport = new StdioClientTransport({
    command: "node",
    args: [resolve(import.meta.dir, "../../dist/cli.js")],
    env: {
      PATH: process.env.PATH ?? "",
      DECIDE_TEST_KEY: "fixture-secret",
      DECIDE_CONFIG_JSON: JSON.stringify({
        model: { provider: "fixture", model: "jev-latest" },
        providers: {
          fixture: {
            kind: "typesafe",
            baseURL: `${api.url}v1`,
            apiKeyEnv: "DECIDE_TEST_KEY",
          },
        },
        maxRetries: 0,
        ...config,
      }),
    },
    stderr: "pipe",
  });

  let stderr = "";

  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  try {
    await client.connect(transport);

    await run(client);

    expect(stderr).not.toContain("fixture-secret");
  } finally {
    await client.close();

    await transport.close();

    await api.stop(true);
  }
}
function nativeResponse({
  choice = "ship",
  probabilities = { ship: 0.75, wait: 0.25 },
}: {
  choice?: string;
  probabilities?: Record<string, number>;
} = {}) {
  return Response.json({
    model: "jev-latest",
    answers: {
      decision: { type: "choice", choice, probabilities, confidence: 0.99 },
    },
    usage: { input_tokens: 10, output_tokens: 0 },
  });
}
test("stdio handshake, discovery, native decision, validation, and secret isolation", async () => {
  let calls = 0;

  await withServer({
    handler: async (request) => {
      calls++;

      expect(new URL(request.url).pathname).toBe("/v1/systemone");

      expect(request.headers.get("authorization")).toBe("Bearer fixture-secret");

      const body = await request.json();

      expect(body.state).toEqual(input);

      return nativeResponse();
    },
    run: async (client) => {
      const list = await client.listTools();

      expect(
        list.tools.map((tool) => {
          return tool.name;
        }),
      ).toEqual(["decide", "evaluate"]);

      expect(list.tools[0]?.outputSchema).toBeDefined();

      const result = await client.callTool({
        name: "decide",
        arguments: input,
      });

      expect(result.isError).not.toBe(true);

      const parsed = Schema.decodeUnknownSync(resultSchema)(result.structuredContent);

      expect(parsed.choices).toEqual([
        { id: "ship", percentage: 75 },
        { id: "wait", percentage: 25 },
      ]);

      expect(parsed.profile).toBe("default");

      const invalid = await client.callTool({
        name: "decide",
        arguments: { ...input, choices: [input.choices[0], input.choices[0]] },
      });

      expect(invalid.isError).toBe(true);

      expect(calls).toBe(1);
    },
  });
});
test("automatic profile selection and explicit tools make two and one calls respectively", async () => {
  const requests: {
    questions: {
      decision: {
        instructions: string;
        criteria: Record<string, string>;
      };
    };
  }[] = [];

  await withServer({
    config: { profiles, tools: "both" },
    handler: async (request) => {
      const body = await request.json();

      requests.push(body);

      return Object.hasOwn(body.questions.decision.criteria, "safety")
        ? nativeResponse({
            choice: "safety",
            probabilities: { default: 0.1, safety: 0.9 },
          })
        : nativeResponse();
    },
    run: async (client) => {
      expect(
        (await client.listTools()).tools.map((tool) => {
          return tool.name;
        }),
      ).toEqual(["decide", "decide-default", "decide-safety", "evaluate"]);

      const routed = Schema.decodeUnknownSync(resultSchema)(
        (await client.callTool({ name: "decide", arguments: input })).structuredContent,
      );

      expect(routed.profile).toBe("safety");

      expect(routed.routing).toMatchObject({
        mode: "automatic",
        selectedPercentage: 90,
      });

      expect(requests).toHaveLength(2);

      expect(requests[1]?.questions.decision.instructions).toContain("Prefer reversible changes.");

      const explicit = Schema.decodeUnknownSync(resultSchema)(
        (await client.callTool({ name: "decide-safety", arguments: input })).structuredContent,
      );

      expect(explicit.routing.mode).toBe("explicit");

      expect(requests).toHaveLength(3);

      const defaultResult = Schema.decodeUnknownSync(resultSchema)(
        (await client.callTool({ name: "decide-default", arguments: input })).structuredContent,
      );

      expect(defaultResult.profile).toBe("default");

      expect(requests).toHaveLength(4);
    },
  });
});
test("separate tool mode does not route decide", async () => {
  let calls = 0;

  await withServer({
    config: { profiles, tools: "separate" },
    handler: () => {
      calls++;

      return nativeResponse();
    },
    run: async (client) => {
      const result = Schema.decodeUnknownSync(resultSchema)(
        (await client.callTool({ name: "decide", arguments: input })).structuredContent,
      );

      expect(result.profile).toBe("default");

      expect(calls).toBe(1);
    },
  });
});
test("Gateway default uses experimental evaluation transport and preserves missing probabilities", async () => {
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      expect(new URL(request.url).pathname).toBe("/evaluation-model");

      expect(request.headers.get("ai-model-id")).toBe("typesafe-ai/jev");

      return Response.json({
        answers: { decision: { type: "choice", choice: "ship" } },
        warnings: [
          {
            type: "other",
            message: "fixture-secret sensitive provider warning",
          },
        ],
      });
    },
  });

  try {
    await withServer({
      config: {
        model: { provider: "gateway", model: "typesafe-ai/jev" },
        providers: {
          gateway: {
            kind: "gateway",
            baseURL: String(api.url).replace(/\/$/, ""),
            apiKeyEnv: "DECIDE_TEST_KEY",
          },
        },
      },
      handler: () => {
        return Response.error();
      },
      run: async (client) => {
        const result = Schema.decodeUnknownSync(resultSchema)(
          (await client.callTool({ name: "decide", arguments: input })).structuredContent,
        );

        expect(JSON.stringify(result)).not.toContain("fixture-secret");

        expect(result.percentageSource).toBe("unavailable");

        expect(
          result.choices.map((choice) => {
            return choice.percentage;
          }),
        ).toEqual([null, null]);
      },
    });
  } finally {
    await api.stop(true);
  }
});
test.each(["http-error", "malformed", "timeout"])(
  "provider %s returns an MCP tool error without a fake recommendation",
  async (failure) => {
    await withServer({
      config: { timeoutMs: failure === "timeout" ? 100 : 30000 },
      handler: async () => {
        if (failure === "timeout") {
          await Bun.sleep(300);
        }

        if (failure === "http-error") {
          return Response.json({ error: "fixture-secret sensitive context" }, { status: 401 });
        }

        return nativeResponse({ probabilities: { ship: 0.8, wait: 0.8 } });
      },
      run: async (client) => {
        const result = await client.callTool({
          name: "decide",
          arguments: input,
        });

        expect(result.isError).toBe(true);

        expect(result.structuredContent).toBeUndefined();

        expect(JSON.stringify(result)).not.toContain("fixture-secret");

        expect(JSON.stringify(result)).not.toContain("sensitive context");
      },
    });
  },
);
test("OpenAI-compatible language provider returns labeled estimates through the real AI SDK adapter", async () => {
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      expect(new URL(request.url).pathname).toBe("/chat/completions");

      const body = await request.json();

      expect(body.messages[0].role).toBe("system");

      return Response.json({
        id: "fixture",
        object: "chat.completion",
        created: 1,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                choices: [
                  { id: "ship", probability: 0.6 },
                  { id: "wait", probability: 0.4 },
                ],
              }),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      });
    },
  });

  try {
    await withServer({
      config: {
        model: { provider: "local", model: "test-model", mode: "language" },
        providers: {
          local: {
            kind: "openai-compatible",
            baseURL: String(api.url).replace(/\/$/, ""),
          },
        },
      },
      handler: () => {
        return Response.error();
      },
      run: async (client) => {
        const result = Schema.decodeUnknownSync(resultSchema)(
          (await client.callTool({ name: "decide", arguments: input })).structuredContent,
        );

        expect(result.percentageSource).toBe("model-estimate");

        expect(
          result.choices.map((choice) => {
            return choice.percentage;
          }),
        ).toEqual([60, 40]);
      },
    });
  } finally {
    await api.stop(true);
  }
});

test.each(["decide", "evaluate"])(
  "MCP %s cancellation interrupts the provider and leaves the server usable",
  async (toolName) => {
    let started!: () => void;

    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });

    let aborted!: () => void;

    const cancelled = new Promise<void>((resolve) => {
      aborted = resolve;
    });

    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/started") {
          started();
        }

        if (new URL(request.url).pathname === "/aborted") {
          aborted();
        }

        return new Response("ok");
      },
    });

    try {
      await withServer({
        config: {
          providers: {
            fixture: {
              kind: "custom",
              module: resolve(import.meta.dir, "../fixtures/cancellable-provider.ts"),
              export: "createProvider",
              baseURL: String(api.url).replace(/\/$/, ""),
            },
          },
        },
        handler: () => {
          return Response.error();
        },
        run: async (client) => {
          const controller = new AbortController();

          const outcome = client
            .callTool(
              {
                name: toolName,
                arguments:
                  toolName === "decide"
                    ? { ...input, context: "wait-for-cancellation" }
                    : {
                        state: { context: "wait-for-cancellation" },
                        questions: {
                          decision: {
                            type: "choice",
                            instructions: "Choose",
                            criteria: { ship: "Release", wait: "Wait" },
                          },
                        },
                      },
              },
              undefined,
              { signal: controller.signal },
            )
            .then(
              () => {
                return false;
              },
              () => {
                return true;
              },
            );

          await ready;

          controller.abort();

          expect(await outcome).toBe(true);

          await cancelled;

          const result = await client.callTool({
            name: "decide",
            arguments: input,
          });

          expect(result.isError).not.toBe(true);
        },
      });
    } finally {
      await api.stop(true);
    }
  },
);

test("CLI startup errors are nonzero and sanitized", () => {
  const result = spawnSync("node", [resolve(import.meta.dir, "../../dist/cli.js")], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      DECIDE_CONFIG_JSON: '{"secret":"fixture-secret"}',
    },
  });

  expect(result.status).toBe(1);

  expect(result.stdout).toBe("");

  expect(result.stderr).toContain("could not start");

  expect(result.stderr).not.toContain("fixture-secret");
});

test("stdin EOF releases the server scope and exits cleanly", () => {
  const result = spawnSync("node", [resolve(import.meta.dir, "../../dist/cli.js")], {
    encoding: "utf8",
    input: "",
    timeout: 3000,
    env: { PATH: process.env.PATH },
  });

  expect(result.error).toBeUndefined();

  expect(result.status).toBe(0);

  expect(result.stderr).toBe("");
});

const batchInput = {
  state: { tests: "passing", rollback: "unverified" },
  questions: {
    verified: { type: "boolean", instructions: "Was rollback verified?" },
    action: {
      type: "choice",
      instructions: "Which action?",
      criteria: { ship: "Release now", wait: "Verify rollback first" },
    },
    readiness: {
      type: "score",
      instructions: "Rate release readiness.",
      criteria: [
        "Tests missing",
        "Tests pass but recovery unverified",
        "Tests and recovery verified",
      ],
    },
  },
};
const batchAnswers = {
  verified: { type: "boolean", probability: 0.02 },
  action: { type: "choice", choice: "wait", probabilities: { ship: 0.2, wait: 0.8 } },
  readiness: { type: "score", score: 0.9, probabilities: { "0": 0.1, "1": 0.9, "2": 0 } },
} as const;

test.each(["typesafe", "gateway"])(
  "evaluate exposes mixed batches through the %s adapter and discovers explicit profiles",
  async (kind) => {
    let calls = 0;

    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        calls++;

        expect(request.headers.get("authorization")).toBe("Bearer fixture-secret");

        const body = await request.json();

        expect(body.state).toEqual(batchInput.state);

        expect(Object.keys(body.questions)).toEqual(Object.keys(batchInput.questions));

        expect(body.questions.verified.type).toBe(kind === "typesafe" ? "noul" : "boolean");

        expect(JSON.stringify(body.questions.action.instructions)).toContain(
          "Prefer reversible changes",
        );

        if (kind === "gateway") {
          expect(new URL(request.url).pathname).toBe("/evaluation-model");

          return Response.json({
            answers: batchAnswers,
            rounding: { probabilityDecimals: 2, scoreDecimals: 2 },
            providerMetadata: { typesafe: { confidence: { action: 0.63, readiness: 0.8 } } },
            warnings: [],
          });
        }

        expect(new URL(request.url).pathname).toBe("/systemone");

        return Response.json({
          model: "jev-latest",
          answers: {
            verified: { type: "noul", noul: 0.02 },
            action: { ...batchAnswers.action, confidence: 0.63 },
            readiness: { ...batchAnswers.readiness, confidence: 0.8 },
          },
          usage: { input_tokens: 100, output_tokens: 30 },
        });
      },
    });

    try {
      await withServer({
        config: {
          profiles,
          model: {
            provider: "fixture",
            model: kind === "gateway" ? "typesafe-ai/jev" : "jev-latest",
          },
          providers: {
            fixture: {
              kind,
              baseURL: String(api.url).replace(/\/$/, ""),
              apiKeyEnv: "DECIDE_TEST_KEY",
            },
          },
        },
        handler: () => {
          return Response.error();
        },
        run: async (client) => {
          expect(client.getInstructions()).toContain("batch independent questions");

          const tool = (await client.listTools()).tools.find((entry) => {
            return entry.name === "evaluate";
          });

          expect(tool?.description).toContain("safety");

          expect(tool?.inputSchema.properties).toHaveProperty("questions");

          expect(tool?.outputSchema).toBeDefined();

          const response = await client.callTool({
            name: "evaluate",
            arguments: { ...batchInput, profile: "safety" },
          });

          expect(response.isError).not.toBe(true);

          const result = Schema.decodeUnknownSync(evaluationResultSchema)(
            response.structuredContent,
          );

          expect(result.answers).toEqual(batchAnswers);

          expect(result.profile).toBe("safety");

          expect(result.metadata.action?.confidence).toBe(0.63);

          expect(result.metadata.verified?.confidence).toBeNull();

          expect(result.metadata.readiness?.levels).toEqual(
            batchInput.questions.readiness.criteria,
          );

          expect(result.rounding).toEqual({ probabilityDecimals: 2, scoreDecimals: 2 });

          expect(calls).toBe(1);

          for (const argumentsValue of [
            { ...batchInput, profile: "missing" },
            { ...batchInput, questions: {} },
            {
              ...batchInput,
              questions: { q: { type: "boolean", instructions: "Valid?", extra: "invalid" } },
            },
          ]) {
            const invalid = await client.callTool({ name: "evaluate", arguments: argumentsValue });

            expect(invalid.isError).toBe(true);
          }

          expect(calls).toBe(1);
        },
      });
    } finally {
      await api.stop(true);
    }
  },
);

test("evaluate language batches use one provider request and return labeled distributions", async () => {
  let calls = 0;

  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      calls++;

      const body = await request.json();

      expect(new URL(request.url).pathname).toBe("/chat/completions");

      expect(body.response_format.type).toBe("json_object");

      expect(JSON.stringify(body.messages)).toContain("verified");

      return Response.json({
        id: "fixture",
        object: "chat.completion",
        created: 1,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: JSON.stringify({ answers: batchAnswers }) },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      });
    },
  });

  try {
    await withServer({
      config: {
        model: { provider: "fixture", model: "test-model", mode: "language" },
        providers: {
          fixture: { kind: "openai-compatible", baseURL: String(api.url).replace(/\/$/, "") },
        },
      },
      handler: () => {
        return Response.error();
      },
      run: async (client) => {
        const response = await client.callTool({ name: "evaluate", arguments: batchInput });

        expect(response.isError).not.toBe(true);

        const result = Schema.decodeUnknownSync(evaluationResultSchema)(response.structuredContent);

        expect(result.answers).toEqual(batchAnswers);

        expect(
          Object.values(result.metadata).every((entry) => {
            return entry.source === "model-estimate" && entry.confidence === null;
          }),
        ).toBe(true);

        expect(result.usage?.totalTokens).toBe(30);

        expect(calls).toBe(1);
      },
    });
  } finally {
    await api.stop(true);
  }
});

test.each(["http-error", "malformed", "timeout"])(
  "evaluate handles %s with a sanitized MCP error",
  async (failure) => {
    await withServer({
      config: { timeoutMs: failure === "timeout" ? 100 : 30000 },
      handler: async () => {
        if (failure === "timeout") {
          await Bun.sleep(300);
        }

        if (failure === "http-error") {
          return Response.json({ error: "fixture-secret sensitive context" }, { status: 401 });
        }

        return Response.json({ answers: { verified: { type: "noul", noul: 2 } } });
      },
      run: async (client) => {
        const result = await client.callTool({ name: "evaluate", arguments: batchInput });

        expect(result.isError).toBe(true);

        expect(result.structuredContent).toBeUndefined();

        expect(JSON.stringify(result)).not.toContain("fixture-secret");

        expect(JSON.stringify(result)).not.toContain("sensitive context");
      },
    });
  },
);

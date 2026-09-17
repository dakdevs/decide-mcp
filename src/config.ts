import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const text = z.string().trim().min(1);
const identifier = text.max(48).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const modelSchema = z.strictObject({
  provider: text.default("gateway"),
  model: text,
  mode: z.enum(["evaluation", "language"]).default("evaluation"),
  providerOptions: z
    .record(z.string(), z.record(z.string(), z.json()))
    .optional(),
});

export const providerSchema = z
  .strictObject({
    kind: z.enum([
      "gateway",
      "typesafe",
      "openai",
      "anthropic",
      "google",
      "openai-compatible",
      "custom",
    ]),
    apiKeyEnv: text.optional(),
    baseURL: z.url().optional(),
    module: text.optional(),
    export: text.optional(),
    options: z.record(z.string(), z.json()).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "openai-compatible" && !value.baseURL)
      ctx.addIssue({
        code: "custom",
        message: "openai-compatible requires baseURL",
      });
    if (value.kind === "custom" && (!value.module || !value.export))
      ctx.addIssue({
        code: "custom",
        message: "custom requires module and export (a provider factory)",
      });
    if (
      value.kind !== "custom" &&
      (value.module || value.export || value.options)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "module, export, and options are only supported for custom providers",
      });
  });

export const configSchema = z
  .strictObject({
    model: modelSchema.default({
      provider: "gateway",
      model: "typesafe-ai/jev",
      mode: "evaluation",
    }),
    systemPrompt: text
      .max(16000)
      .default(
        "Choose the option best supported by the supplied context. Consider uncertainty and tradeoffs.",
      ),
    providers: z
      .record(identifier, providerSchema)
      .default({ gateway: { kind: "gateway" } }),
    profiles: z
      .array(
        z.strictObject({
          id: identifier.refine(
            (id) => id !== "default",
            "default is reserved",
          ),
          description: text.max(2000),
          systemPrompt: text.max(16000),
          model: modelSchema.optional(),
        }),
      )
      .max(32)
      .default([]),
    tools: z.enum(["routed", "separate", "both"]).default("routed"),
    router: z
      .strictObject({
        model: modelSchema.optional(),
        systemPrompt: text
          .max(16000)
          .default(
            "Select the most relevant decision profile based on its purpose. Use default when no specialized profile clearly applies. Do not select a profile just to obtain a desired answer.",
          ),
        minimumProbability: z.number().min(0).max(1).default(0),
      })
      .default({
        systemPrompt:
          "Select the most relevant decision profile based on its purpose. Use default when no specialized profile clearly applies. Do not select a profile just to obtain a desired answer.",
        minimumProbability: 0,
      }),
    timeoutMs: z.number().int().min(1).max(300000).default(30000),
    maxRetries: z.number().int().min(0).max(5).default(2),
  })
  .superRefine((config, ctx) => {
    const ids = config.profiles.map((profile) => profile.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", message: "Profile IDs must be unique" });
    for (const model of [
      config.model,
      config.router.model,
      ...config.profiles.map((p) => p.model),
    ]) {
      if (model && !Object.hasOwn(config.providers, model.provider))
        ctx.addIssue({
          code: "custom",
          message: `Unknown provider: ${model.provider}`,
        });
    }
  });

export type Config = z.infer<typeof configSchema>;
export type ModelConfig = z.infer<typeof modelSchema>;

export async function loadConfig({
  path,
  json,
}: {
  path?: string;
  json?: string;
}) {
  if (path && json)
    throw new Error(
      "Use either --config / DECIDE_CONFIG or DECIDE_CONFIG_JSON, not both.",
    );
  const contents = path ? await readFile(resolve(path), "utf8") : json;
  return {
    config: configSchema.parse(contents ? JSON.parse(contents) : {}),
    baseDirectory: path ? dirname(resolve(path)) : process.cwd(),
  };
}

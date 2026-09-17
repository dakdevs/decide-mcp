import type { Experimental_EvaluationModel } from "ai";

export function createProvider({ baseURL }: { baseURL: string }) {
  return {
    evaluationModel(modelId: string): Experimental_EvaluationModel {
      return {
        specificationVersion: "v4",
        provider: "cancellation-fixture",
        modelId,
        supportedQuestionTypes: ["choice"],
        async doEvaluate({ state, abortSignal }) {
          if (
            typeof state === "object" &&
            state !== null &&
            "context" in state &&
            state.context === "wait-for-cancellation"
          ) {
            await new Promise<never>((_resolve, reject) => {
              const abort = () => {
                globalThis.fetch(`${baseURL}/aborted`).then(() => {
                  return reject(new Error("aborted"));
                }, reject);
              };

              abortSignal?.addEventListener("abort", abort, { once: true });

              if (abortSignal?.aborted) {
                abort();
              } else {
                globalThis.fetch(`${baseURL}/started`).catch(reject);
              }
            });
          }

          return {
            answers: {
              decision: {
                type: "choice",
                choice: "ship",
                probabilities: { ship: 0.75, wait: 0.25 },
              },
            },
            warnings: [],
          };
        },
      };
    },
  };
}

export function createProvider({ baseURL }) {
  return {
    evaluationModel(modelId) {
      return {
        specificationVersion: "v4",
        provider: "cancellation-fixture",
        modelId,
        supportedQuestionTypes: ["choice"],
        async doEvaluate({ state, abortSignal }) {
          if (state.context === "wait-for-cancellation") {
            await new Promise((resolve, reject) => {
              const abort = () => {
                globalThis
                  .fetch(`${baseURL}/aborted`)
                  .then(() => reject(new Error("aborted")), reject);
              };
              abortSignal.addEventListener("abort", abort, { once: true });
              if (abortSignal.aborted) abort();
              else globalThis.fetch(`${baseURL}/started`).catch(reject);
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

---
name: decide-mcp
description: Use the decide-mcp tools for focused evidence checks, classification, rubric assessments, and recommendations among alternatives when those tools are connected.
---

Use the connected MCP's tool schemas as the contract. Provider credentials and models are configured by the operator; tool calls do not accept secrets or provider modules.

## Choose a tool

- `evaluate`: ask one or more Boolean, Choice, or Score questions about shared evidence. Specify a profile only when its published purpose fits; omission uses the global default policy without routing.
- `decide`: submit a decision, context, and distinct alternatives when you want a recommendation. It may select a configured bias automatically. Explicit `decide-<profile>` tools, if advertised, bypass that routing.

Use these for judgments that benefit from another model: classifying intent, checking whether evidence supports a claim, comparing candidate approaches, or assessing severity and relevance. Keep arithmetic, exact string matching, execution, and extended reasoning in code or the calling agent. Don't delegate explicit user instructions or use a model recommendation as authorization.

## Write useful evaluations

Pass relevant evidence in `state` and judgments in `questions`. Batch independent questions sharing that evidence. A question cannot use a sibling question's answer; use another call when that dependency is real. A batch is one state, not independent states per question.

Question IDs are output labels and are not shown to Jev. Write self-contained instructions. Include the claim and supporting source when verifying evidence; an absent fact cannot be recovered by confidence.

- `boolean`: asks whether a specific statement is true. `probability` is P(true); 0.5 expresses uncertainty, not a medium degree.
- `choice`: uses 2–255 distinct named options with descriptions. Include an unknown or none-applies option when the list is not exhaustive.
- `score`: uses 2–10 ordered, concrete level descriptions. Returned scores are positions between zero and the last level index. Each level should make sense on its own. Split independent dimensions into separate questions.

Instructions and criteria can be strings, JSON objects, or arrays. Use structured descriptions when examples or boundary cases clarify the distinction. Limit each batch to 64 questions and 100,000 serialized characters including state and questions; provider token limits also apply.

## Interpret the result

Read `answers` together with per-question `metadata`. Preserve native distributions and rounding; they may not sum to exactly one after rounding. Confidence is a separate provider statistic describing distribution concentration, not probability of correctness. Boolean answers have no separate confidence. Null confidence and absent distributions mean unavailable, not zero.

`model-estimate` marks language-model estimates, not calibrated native probabilities. Scores are rubric positions, not percentages or exact numeric measurements. A composite weighted score is a utility measure, not a probability.

Treat uncertain or contradictory results as a reason to inspect the evidence or refine an ambiguous question. Avoid rerunning an unchanged question merely to get a preferred answer. Tool errors produce no valid recommendation. Jev provides typed judgments, not free-text explanations; any explanation you write is your own synthesis from the evidence.

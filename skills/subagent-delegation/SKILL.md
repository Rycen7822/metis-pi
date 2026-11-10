---
name: subagent-delegation
description: Prepare bounded subagent tasks and follow-ups with model-appropriate detail. Use before spawning or assigning work through subagents_* tools.
---

# Subagent Delegation

Delegate independent work only when it meaningfully helps. The child does not inherit the parent's conversation: put necessary context in its task. Keep parallel writers on disjoint files or workspaces, and obey the project's concurrency limits. In shared workspaces, explicitly forbid repository-wide stash/reset/checkout for baselines; use a read-only Git snapshot or an isolated copy instead.

## Choose the instruction style

Follow user instructions and observed model behavior first. As adjustable defaults, use detailed guidance for fast/lightweight (Flash-class) models and models that benefit from explicit sequencing. Use outcome-led guidance for models with strong reasoning, planning and dependable autonomous execution, giving them more freedom to choose their approach.

Choose by demonstrated capability relative to the task, not a fixed provider/model list or the Flash label alone. Adjust context and instruction detail to task complexity, uncertainty and risk. Even strong models need clear boundaries and acceptance criteria, but not an unnecessarily prescribed implementation. Do not change the selected model or thinking level just to change style.

### Detailed guidance — fast/lightweight models

State the concrete goal, relevant facts, known starting paths and allowed edits. Separate confirmed findings from hypotheses. Give a short order of investigation, existing checks when known, required evidence and a clear stopping condition. Identify prohibited side effects and what to report when blocked.

Do not invent paths or commands to fill a template. If the cause is unknown, specify the first useful observation rather than demanding a predetermined diagnosis. Allow justified changes of approach within the assigned boundary; avoid repetitive micromanagement.

### Outcome-led guidance — strong autonomous models

State the goal, essential context, ownership boundary, contracts to preserve and acceptance criteria. Let the child choose its investigation, design and verification. Supply important trade-offs without prescribing an implementation. Expand scope only for a concrete dependency or correctness risk.

## Shared boundaries and completion

Neither style relaxes permissions, project rules or approval requirements. Autonomous work does not authorize unrelated changes, installation, commits or pushes. Preserve the existing default model unless the user or an actual capability constraint calls for another. Use the tools' own metadata for invocation details.

Ask for the changed artifacts, meaningful checks and their results, plus unresolved limits. Require the check's actual exit status, not merely the status of a filtering pipeline. A completed run means the model stopped, not that the task passed acceptance. Inspect the artifacts and relevant evidence before integrating or reporting success. Stop when the assigned outcome is sufficiently verified; do not add repeated reviews or test rounds without a specific remaining question.

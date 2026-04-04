# Terminal-Bench Pilot: Evaluating Salon Multi-Agent Collaboration

## Status

Proposal stage. Not yet implemented.

---

## 1. Background & Goal

### What salon is

Salon is a multi-agent collaboration tool that coordinates guest agents (Claude Code, Codex CLI) from a host agent, all running in tmux panes within a shared session. The host manages task delegation, structured discussions, and synthesis. Guests run as independent agent instances that communicate with the host via a Unix socket.

### Why we're doing this

We want to validate the hypothesis: **cross-model multi-agent collaboration (Claude Code + Codex CLI working together via salon) produces higher task resolution rates than a single agent working alone.**

This is the core value proposition of salon. Without quantitative evidence, it's a hypothesis. Terminal-Bench provides a reproducible benchmark with statistical rigor (multiple runs, confidence intervals).

### What Terminal-Bench is

[Terminal-Bench](https://github.com/laude-institute/terminal-bench) is an open-source benchmark (Apache 2.0) from Stanford + Laude Institute. It evaluates autonomous agents on 89 hard, real-world terminal tasks spanning software engineering, ML, security, data science, and system administration.

**How it works:**
- Each task runs in an isolated Docker container with a pre-configured environment
- The agent receives an English task description and terminal access (via `TmuxSession`)
- After the agent finishes (or times out), test scripts check the container's final state
- **Scoring is binary pass/fail** — resolution rate (% of tasks passed) is the primary metric
- Results require minimum 5 runs per configuration for 95% confidence intervals

**Current top performance:** ~82% aggregate (ForgeCode with GPT-5.4 / Opus 4.6). Many individual tasks remain unsolved by any agent.

**Limitation for salon:** Pass/fail scoring doesn't capture reasoning quality — only whether the end state is correct. If salon's multi-agent approach produces the same final answer through better analysis, Terminal-Bench won't differentiate. But if it increases the resolution rate (solves more tasks), that's a strong signal.

### Papers & links

- Repo: https://github.com/laude-institute/terminal-bench
- Paper: https://arxiv.org/abs/2601.11868
- Leaderboard: https://www.tbench.ai/leaderboard/terminal-bench/2.0
- Agent docs: https://www.tbench.ai/docs/agent-introduction

---

## 2. Architecture Decision: How to Integrate

### Option A: BaseAgent adapter

Write a Python `BaseAgent` subclass that wraps salon as a single agent entry point. The adapter launches salon's multi-agent coordination internally and funnels all terminal actions through the Terminal-Bench `TmuxSession`.

**Pros:** Reproducible, scriptable, runs via `tb run`, produces standard results for leaderboard submission, supports automated 5-run trials.
**Cons:** Requires significant adapter engineering (salon doesn't have a programmatic API today).

### Option B: Manual testing

Run salon manually against each task's Docker container, record pass/fail results by hand.

**Pros:** No adapter code needed.
**Cons:** Not reproducible, can't automate multiple runs, no standard results format, can't submit to leaderboard.

### Recommendation

**Start with Option A.** The value of this pilot is in the statistical comparison (5 runs × 5 tasks = 25 salon evaluations, compared against existing leaderboard baselines). Manual testing wouldn't produce reproducible, comparable results. The adapter investment pays for itself immediately and enables future benchmarking.

---

## 3. Adapter Design

### Terminal-Bench agent interface

The adapter must subclass `BaseAgent` and implement:

```python
from terminal_bench.agents.base_agent import BaseAgent, AgentResult
from terminal_bench.terminal.tmux_session import TmuxSession
from pathlib import Path

class SalonAgent(BaseAgent):
    @staticmethod
    def name() -> str:
        return "salon"

    def perform_task(
        self,
        task_description: str,
        session: TmuxSession,
        logging_dir: Path | None = None,
    ) -> AgentResult:
        # Coordinate multi-agent work here
        ...
```

### TmuxSession API (what the adapter gets)

The `TmuxSession` provides:
- `send_keys(keys, block=False, min_timeout_sec=0, max_timeout_sec=180)` — send text/commands to the terminal
- `send_command(command: TerminalCommand)` — structured command execution
- `capture_pane(capture_entire=False)` — read current terminal output
- `get_incremental_output()` — read new output since last check
- `copy_to_container(paths, container_dir, container_filename)` — copy files into the container

This is **one terminal session** into the task's Docker container. All agent actions must go through it.

### The core challenge

Salon currently works as a TUI orchestrator: guests are independent Claude Code / Codex CLI instances, each with their own tool calls (Read, Bash, Edit, etc.) operating on the local filesystem. In Terminal-Bench, the task environment is a Docker container accessible only through `TmuxSession`.

**Two adapter architectures are possible:**

#### Architecture A: Host-as-executor

The salon host coordinates guests as usual, but guests only reason and advise — they don't execute commands directly. The adapter translates guest advice into `TmuxSession` commands.

```
Terminal-Bench
    │
    ▼
SalonAgent.perform_task(task_description, session)
    │
    ├─ Launch salon host (programmatic mode)
    ├─ Host invites Guest A (Claude Code) and Guest B (Codex CLI)
    │   └─ Guests run in "advisor mode" — they analyze, plan, suggest commands
    │       but don't have direct terminal access
    │
    ├─ Host collects guest analysis/proposals
    ├─ Host (or adapter) translates into session.send_keys() calls
    ├─ Host reads session.capture_pane() to get results
    ├─ Host relays results back to guests for next iteration
    └─ Loop until task complete or timeout
```

**Pros:** Clean separation; guests don't need modification; adapter controls all terminal I/O.
**Cons:** Loses the agents' autonomous tool-use capabilities; the host becomes a bottleneck; guests can't explore the codebase themselves.

#### Architecture B: Guest-as-executor via TmuxSession proxy

Guests retain their autonomy but their tool calls are intercepted and redirected through `TmuxSession`. When a guest does `Read(file_path)`, it's translated to `session.send_keys("cat file_path")` + `session.capture_pane()`.

```
Terminal-Bench
    │
    ▼
SalonAgent.perform_task(task_description, session)
    │
    ├─ Launch salon with TmuxSession proxy backend
    ├─ Guest tool calls intercepted:
    │   Read(path)  → session.send_keys("cat path") → capture → return to guest
    │   Bash(cmd)   → session.send_keys(cmd) → capture → return to guest
    │   Edit(path)  → session.send_keys("sed ...") → capture → return to guest
    │   Grep(...)   → session.send_keys("grep ...") → capture → return to guest
    │
    └─ Guests work autonomously, just with redirected I/O
```

**Pros:** Preserves guest autonomy and tool-use; more realistic test of salon's multi-agent coordination.
**Cons:** Complex proxy layer; need to serialize terminal access (only one session); tool call translation is lossy (e.g., Read with line ranges doesn't map cleanly to `cat`).

#### Architecture C: Guests use the container terminal directly (simplest)

Skip the proxy. Give each guest the task description and instructions to work by running commands in the terminal. Guests take turns using `session.send_keys()` through a shared queue managed by the adapter.

```
Terminal-Bench
    │
    ▼
SalonAgent.perform_task(task_description, session)
    │
    ├─ Brief: "You are working in a Docker container.
    │          Use only bash commands to solve this task.
    │          Do not use Read/Edit/Grep tools — use cat/sed/grep directly."
    │
    ├─ Guest A analyzes task, proposes plan
    ├─ Guest B reviews plan, suggests improvements
    ├─ Executor guest sends bash commands via adapter
    │   adapter.execute(cmd) → session.send_keys(cmd) → capture output → return
    └─ Review/iterate until done
```

**Pros:** Simplest to implement; salon orchestration works as-is (guests communicate naturally); no tool call interception needed.
**Cons:** Guests lose their native tool efficiency (Edit is better than sed); requires careful briefing so guests don't try to use their built-in tools.

### Recommendation

**Start with Architecture C** (guests use bash commands via adapter). This is the minimum viable integration:
- No changes to salon core
- Adapter manages a command queue and terminal access
- Guests are briefed to work via bash commands only
- Host coordinates who plans, who executes, who reviews

If Architecture C shows promise, Architecture B (tool call proxy) can be built later for a more rigorous comparison.

---

## 4. Baseline Design

### Reusing existing leaderboard data

Terminal-Bench publishes per-task, per-trial results on HuggingFace at [`harborframework/terminal-bench-2-leaderboard`](https://huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard). Each submission contains individual `result.json` files per task per trial, including `verifier_result.rewards.reward` (0.0 or 1.0), token counts, cost, and timing.

**We will reuse existing leaderboard results as baselines instead of running our own single-agent evaluations.** This saves significant cost and time. Multiple top agents already have 5-run results for all 89 tasks.

### Baseline configurations (from leaderboard)

| Config | Source | Model | Aggregate |
|---|---|---|---|
| Forge + GPT-5.4 | `Forge__GPT-5.4` | GPT-5.4 | 81.8% |
| Forge + Opus 4.6 | `Forge__Opus-4.6` | Claude Opus 4.6 | 81.8% |
| Terminus2 + Opus 4.6 | `Terminus2__Claude-Opus-4.6` | Claude Opus 4.6 | ~66% |
| Droid + Codex | `Droid__GPT-5.3-Codex` | GPT-5.3 Codex | 77.3% |

### What we need to run

Only the salon multi-agent configuration:

| Config | Agents | Model(s) |
|---|---|---|
| `salon-multi` | Claude Code + Codex CLI via salon | Opus 4.6 + Codex default |
| `salon-same-model` (optional) | 2× Claude Code via salon | 2× Opus 4.6 |

### How to access baseline data

```python
# Per-task result for a specific agent/task/trial:
# https://huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard/
#   raw/main/submissions/terminal-bench/2.0/<Agent>__<Model>/<job>/<task>__<hash>/result.json

# Key fields in result.json:
# verifier_result.rewards.reward  → 0.0 (fail) or 1.0 (pass)
# agent_result.n_input_tokens     → total input tokens
# agent_result.n_output_tokens    → total output tokens
# agent_result.cost_usd           → API cost for this trial
# started_at / finished_at        → wall-clock timing
```

---

## 5. Selected Tasks (5 tasks)

Tasks were selected based on per-task pass rates across the top 4 leaderboard agents (Forge GPT-5.4, Forge Opus 4.6, Terminus2 Opus 4.6, Droid Codex). We targeted tasks in the 0-60% best pass rate range — hard enough that there's room for multi-agent collaboration to improve resolution rate.

### Task 1: dna-assembly

| Field | Value |
|---|---|
| Domain | Scientific computing |
| Difficulty | Hard |
| Expert time | not specified |
| Resources | 1 CPU, 2GB RAM |
| Best single-agent pass rate | **40%** (Terminus2 Opus 4.6) |
| Other agents | Forge GPT-5.4: 0%, Forge Opus: 0%, Droid Codex: 0% |

**Description:** Design primers for Gibson Assembly plasmid cloning. Given a circular input plasmid and an EGFP sequence, design overlapping primers that will assemble the insert into the plasmid at the correct location.

**Why selected:** Requires biology domain knowledge (Gibson Assembly protocol, restriction enzymes, melting temperatures) + bioinformatics (sequence manipulation, primer design). Only one agent solves it at all (40%), and it's a different agent than the top-ranked ones — suggesting model diversity matters.

**Multi-agent hypothesis:** One agent researches the biology and designs the assembly strategy; another handles sequence computation and primer optimization.

### Task 2: model-extraction-relu-logits

| Field | Value |
|---|---|
| Domain | Mathematics / Security |
| Difficulty | Hard |
| Expert time | not specified |
| Resources | 1 CPU, 2GB RAM |
| Best single-agent pass rate | **40%** (Droid Codex) |
| Other agents | Forge GPT-5.4: 20%, Forge Opus: 0%, Terminus2 Opus: 0% |

**Description:** Extract the weight matrix of a one-layer ReLU neural network through query access only. Given a black-box `forward(x)` function (A2 · ReLU(A1·x + b1) + b2), recover A1 by making queries and save to `/app/stolen_A1.npy`.

**Why selected:** Requires mathematical reasoning about ReLU networks (identifying activation regions, linear algebra) + adversarial ML techniques. The model that solves it best (Codex) differs from the top-ranked agent (Forge) — different models bring different mathematical intuitions.

**Multi-agent hypothesis:** One agent works out the mathematical approach (exploit ReLU piecewise linearity, identify hyperplanes); another implements and validates the extraction. Two perspectives on the math increase the chance of finding the right attack strategy.

### Task 3: gpt2-codegolf

| Field | Value |
|---|---|
| Domain | Software engineering |
| Difficulty | Hard |
| Expert time | not specified |
| Resources | 1 CPU, 8GB RAM |
| Best single-agent pass rate | **60%** (Forge GPT-5.4 and Forge Opus, tied) |
| Other agents | Terminus2 Opus: 0%, Droid Codex: 20% |

**Description:** Write a dependency-free C file (<5000 bytes) that loads GPT-2 weights from a TF checkpoint, loads BPE vocabulary, and performs argmax sampling for 20 tokens. Compiled with `gcc -O3 -lm`.

**Why selected:** Requires deep understanding of the transformer architecture (attention, layer norm, BPE tokenization) AND extreme code optimization under a hard size constraint. Planning is critical — you can't iterate freely when every byte counts.

**Multi-agent hypothesis:** One agent handles the architecture (correct attention computation, weight loading from checkpoint format); another focuses on size optimization (code golf techniques, dead code elimination, minimal I/O). The size constraint makes upfront planning more valuable than trial-and-error.

### Task 4: sam-cell-seg

| Field | Value |
|---|---|
| Domain | Data science / ML |
| Difficulty | Hard |
| Expert time | not specified |
| Resources | 1 CPU, 4GB RAM |
| Best single-agent pass rate | **60%** (Forge GPT-5.4) |
| Other agents | Forge Opus: 0%, Terminus2 Opus: 0%, Droid Codex: 0% |

**Description:** Convert rectangle cell masks in annotated histopathology slides to polyline masks using Facebook's Segment Anything Model (SAM). Must use SAM specifically for the rectangle-to-polyline conversion.

**Why selected:** Only one agent (Forge GPT-5.4) solves it, and only 60% of the time. Requires image processing + ML model setup (SAM installation and inference) + domain-specific output formatting. The stark agent disagreement (60/0/0/0) suggests this task is sensitive to approach — different starting strategies lead to very different outcomes.

**Multi-agent hypothesis:** One agent handles SAM model setup and inference pipeline; another handles the mask conversion logic and output format. Cross-model collaboration may find the right approach where single models get stuck.

### Task 5: filter-js-from-html

| Field | Value |
|---|---|
| Domain | Security |
| Difficulty | Medium |
| Expert time | not specified |
| Resources | 1 CPU, 4GB RAM |
| Best single-agent pass rate | **0%** (unsolved by all agents) |
| Other agents | All 0% across all top agents |

**Description:** Create a Python script that removes JavaScript from HTML files to prevent XSS attacks while preserving as much HTML as possible (formatting, tables, headers, non-dangerous attributes).

**Why selected:** Currently unsolved by any agent despite being rated "medium" difficulty. The challenge is likely in the breadth of XSS vectors the test suite checks — agents probably handle common cases but miss edge cases. This is exactly where multi-agent cross-review could help: two models checking each other's XSS filtering logic catch more edge cases than one.

**Multi-agent hypothesis:** One agent handles the core HTML parsing and JS removal; another performs adversarial review — actively trying to find XSS bypass vectors in the first agent's solution. The security domain naturally benefits from attacker/defender role separation.

**Risk:** The 0% pass rate could indicate a test infrastructure issue rather than genuine task difficulty. If early investigation reveals this, swap in **raman-fitting** (scientific computing, 40%) or **dna-insert** (scientific computing, 40%).

### Agent disagreement: evidence for cross-model hypothesis

A striking finding from the per-task analysis: many tasks show stark disagreement between agents using different models. One agent solves a task 100% of the time while another gets 0%:

| Task | Forge GPT-5.4 | Forge Opus | Terminus2 Opus | Droid Codex |
|---|---|---|---|---|
| fix-code-vulnerability | 0% | 0% | **100%** | **100%** |
| chess-best-move | **100%** | 0% | 80% | **100%** |
| torch-pipeline-parallelism | **100%** | 20% | 60% | 0% |
| mailman | 20% | 0% | **80%** | **100%** |
| compile-compcert | **100%** | **100%** | 0% | 80% |
| sam-cell-seg | **60%** | 0% | 0% | 0% |

This directly supports salon's cross-model hypothesis: if different models excel at different tasks, a system that combines their perspectives should capture a superset of their individual capabilities. The tasks we selected for the pilot deliberately include high-disagreement cases (sam-cell-seg, gpt2-codegolf).

If the pilot shows promise, these high-disagreement tasks would be the strongest candidates for an expanded evaluation.

---

## 6. Evaluation Protocol

### Configurations

| Config | Source | Agents | Model(s) |
|---|---|---|---|
| `baseline-forge-gpt54` | Leaderboard (existing) | Forge | GPT-5.4 |
| `baseline-forge-opus` | Leaderboard (existing) | Forge | Opus 4.6 |
| `baseline-terminus2-opus` | Leaderboard (existing) | Terminus2 | Opus 4.6 |
| `baseline-droid-codex` | Leaderboard (existing) | Droid | GPT-5.3 Codex |
| `salon-multi` | **New (run ourselves)** | Claude Code + Codex CLI via salon | Opus 4.6 + Codex default |
| `salon-same-model` (optional) | **New (run ourselves)** | 2× Claude Code via salon | 2× Opus 4.6 |

### Runs

- **Baselines:** Already available with 5 runs per task from the HuggingFace dataset. No new runs needed.
- **Salon configs:** 5 runs per task per configuration (minimum for 95% CI)
- New evaluations needed: 5 tasks × 5 runs = **25 evaluations** (salon-multi), optionally +25 (salon-same-model)

### Metrics

**Primary:** Resolution rate (% of tasks passed per configuration)

**Secondary (from result.json):**
- Token usage (`n_input_tokens`, `n_output_tokens`) — compare salon's total across both agents vs single-agent baselines
- Wall-clock time (`started_at` / `finished_at`) — does multi-agent take longer?
- Cost (`cost_usd`) — is the multi-agent overhead justified by improved resolution?

### Running

```bash
# Install
pip install terminal-bench

# Salon multi-agent (custom adapter) — the only config we need to run
tb run --agent-import-path salon_tbench.adapter:SalonAgent \
  --dataset terminal-bench-core==0.1.1 \
  --task-id dna-assembly \
  --n-runs 5
```

### Baseline data extraction

```python
# Extract baseline results from HuggingFace for comparison
# See Section 4 for the API pattern
# Script: salon_tbench/extract_baselines.py
```

### Result analysis

For each configuration, compute:
- Pass rate ± stderr per task
- Aggregate pass rate ± stderr across all 5 tasks
- Token efficiency: tokens per successful task vs tokens per failed task
- Time comparison: does multi-agent take longer but succeed more?
- **Cross-agent comparison**: does salon solve tasks that NO single agent solves? (Especially filter-js-from-html at 0%)

---

## 7. Implementation Steps

### Step 1: Setup and verify Terminal-Bench

- Install `terminal-bench` and Docker
- Run the built-in `claude-code` agent on a single easy task (e.g., `kv-store-grpc` or `openssl-selfsigned-cert`) to verify the harness works
- Understand the `TmuxSession` API by reading terminal-bench source
- Estimated time: half a day

### Step 2: Extract and validate baseline data

- Write `salon_tbench/extract_baselines.py` to pull per-task results from HuggingFace dataset
- Validate that all 5 selected tasks have 5-run data for at least 3 baseline agents
- Generate a baseline comparison table for reference during analysis
- Estimated time: half a day

### Step 3: Implement salon multi-agent adapter

This is the main engineering work. Create `salon_tbench/adapter.py`:

```python
class SalonAgent(BaseAgent):
    @staticmethod
    def name() -> str:
        return "salon"

    def perform_task(self, task_description, session, logging_dir=None):
        # 1. Create salon instance (programmatic mode)
        # 2. Brief host with task_description
        # 3. Host invites Claude Code + Codex CLI guests
        # 4. Guests plan and coordinate
        # 5. Execute commands via session.send_keys()
        # 6. Read output via session.capture_pane()
        # 7. Iterate until guests signal completion
        # 8. Return AgentResult with token counts
        ...
```

Key sub-tasks:
- **Command execution layer**: Queue + serialize guest command requests through the single `TmuxSession`
- **Guest briefing**: Instructions telling guests to work via bash commands (no built-in tools)
- **Completion detection**: How does the adapter know the agents are done?
- **Token tracking**: Aggregate token usage from both guest sessions for `AgentResult`
- Estimated time: 3-5 days

### Step 4: Run pilot on 5 tasks

- Run salon-multi on all 5 tasks (25 evaluations)
- Optionally run salon-same-model (additional 25 evaluations)
- Monitor for flaky failures, timeouts, or adapter bugs
- Estimated time: 1-2 days (mostly wall-clock waiting)

### Step 5: Analyze results

- Compute resolution rates with confidence intervals
- Compare: does salon solve any tasks that single agents can't?
- Analyze failure modes: when salon fails, is it coordination overhead or agent capability?
- Write up findings
- Estimated time: 1 day

---

## 8. Cost & Resource Estimate

### Hardware

- Machine with Docker support
- 1-2 CPUs, 2-8GB RAM per container (varies by task)
- `gpt2-codegolf` needs 8GB RAM; `sam-cell-seg` needs 4GB; others need 2-4GB
- Can run tasks in parallel with `--n-concurrent` if hardware allows

### API costs

Baselines are free (reusing existing leaderboard data). We only pay for salon runs.

Per salon evaluation (two agents collaborating on one task):
- Salon uses ~2× the tokens of a single agent (two model calls per round)
- Based on baseline data: single-agent cost per trial ranges from $0.25 (easy) to $1.50 (hard)
- Estimated salon cost per trial: ~$2-5 (higher due to coordination overhead)
- Average: ~$3.50 per evaluation

For the pilot:
- `salon-multi`: 25 evaluations × $3.50 = **~$88**
- `salon-same-model` (optional): 25 evaluations × $3.50 = **~$88**
- **Total: ~$88-175 in API costs**

### Time

- Setup + baseline extraction: 1 day
- Salon adapter: 3-5 days
- Running pilot: 1-2 days
- Analysis: 1 day
- **Total: ~1.5 weeks**

---

## 9. Open Questions

### Q1: How exactly do guests interact with the container?

The simplest approach (Architecture C above) has guests reason and plan, then the adapter executes their bash commands via `TmuxSession`. But this means guests can't use their native tool calls (Read, Edit, Grep) which they're optimized for. Does this handicap salon unfairly? Or does it level the playing field (single-agent baselines face the same constraint)?

**Recommendation:** Start with Architecture C. If salon's value is in coordination and planning quality, it should show up even with bash-only execution. If the pilot results are ambiguous, invest in Architecture B (tool call proxy) for a fairer comparison.

### Q2: Do we need to modify salon core?

Ideally, the adapter is a separate Python module (`salon_tbench/`) that imports salon as a library. But salon is currently a pi extension (TypeScript) with a TUI-centric architecture, not a Python library.

**Options:**
1. **Subprocess approach**: The Python adapter launches salon as a subprocess, communicates via its existing Unix socket protocol
2. **Port to Python**: Rewrite the coordination logic in Python for the adapter (significant effort, not recommended for a pilot)
3. **Minimal Python shim**: The adapter directly uses the Anthropic and OpenAI APIs to simulate what salon does — host coordinates two model calls, no actual salon instance needed

**Recommendation:** Option 3 for the pilot. The adapter implements salon-like coordination directly in Python: one Opus call for planning/analysis, one Codex call for a second perspective, then coordinated execution. This tests the multi-agent hypothesis without requiring salon infrastructure changes. If the pilot validates the hypothesis, invest in proper salon integration (Option 1).

### Q3: Should we add a same-model configuration?

A third config with two Claude Code agents (same model) would isolate the **cross-model effect** (Claude + Codex) from the **multi-agent effect** (two agents vs one). If `salon-multi` outperforms both baselines but `salon-same-model` doesn't, the value is in model diversity. If both salon configs outperform, the value is in multi-agent coordination itself.

**Recommendation:** Yes, add this as a fourth config. The marginal cost is 25 more evaluations (~$75). The analytical value is high.

### Q4: What if resolution rates are identical?

Terminal-Bench's binary pass/fail may not capture salon's value if that value is in reasoning quality rather than task completion. If salon's resolution rate equals single agents, we should:
- Examine per-task results (salon may solve different tasks than single agents)
- Check token efficiency (salon may solve the same tasks with fewer tokens)
- Check failure analysis (salon may fail differently — closer to success, better diagnosis)
- Consider a complementary evaluation with human judges scoring reasoning quality on a separate task set

### Q5: Terminal-Bench 2.0 vs Core

The leaderboard uses `terminal-bench-core@0.1.1`, which is a subset of the full task set. Our 5 selected tasks need to be verified as part of this core set. If any aren't included, we'll need to either substitute or run against the full `terminal-bench@2.0` dataset.

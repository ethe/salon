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

**Start with Option A.** The value of this pilot is in the statistical comparison (5 runs × 3 configurations × 5 tasks = 75 evaluations). Manual testing at that scale is impractical. The adapter investment pays for itself immediately and enables future benchmarking.

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

The control group is a single agent working alone with the same `TmuxSession`. This isolates the variable: multi-agent coordination vs single agent.

### Single-agent baselines

Three baseline configurations:

1. **Claude Code (single)** — One Claude Code instance working alone. Uses Anthropic Opus 4.6.
2. **Codex CLI (single)** — One Codex CLI instance working alone. Uses the default Codex model.
3. **Salon (multi-agent)** — One Claude Code + one Codex CLI, coordinated by the salon host.

The single-agent baselines can use `AbstractInstalledAgent` (Claude Code is already implemented in Terminal-Bench) or a simple `BaseAgent` wrapper that just passes the task to one agent instance.

**Important:** Terminal-Bench already has Claude Code as a built-in agent (`tb run --agent claude-code`). We may be able to use this directly as our baseline, avoiding the need to implement baseline adapters ourselves. Verify this during Step 1.

---

## 5. Selected Tasks (5 tasks)

### Task 1: protein-assembly

| Field | Value |
|---|---|
| Domain | Scientific computing |
| Difficulty | Hard |
| Expert time | 60 minutes |
| Resources | 1 CPU, 4GB RAM |

**Description:** Design a synthetic DNA fragment (gBlock) encoding a fusion protein for DHFR stability testing via FRET. Requires selecting fluorescent proteins from PDB, parsing antibody sequences from FASTA, extracting DHFR from a GenBank plasmid, designing GS linkers, optimizing codons for GC content, and assembling into a <3000 nucleotide construct.

**Why selected:** Requires cross-domain reasoning — biology (protein databases), bioinformatics (sequence parsing), and computational biology (codon optimization). High planning value. A planner/researcher + executor split could help.

**Multi-agent hypothesis:** One agent researches protein databases and selects components; another handles DNA sequence design and constraint satisfaction (GC content, length limits).

### Task 2: fix-code-vulnerability

| Field | Value |
|---|---|
| Domain | Security |
| Difficulty | Hard |
| Expert time | 120 minutes |
| Resources | 1 CPU, 2GB RAM |

**Description:** Audit the Bottle web framework for security vulnerabilities against the CWE taxonomy. Produce a structured JSONL vulnerability report, fix all identified vulnerabilities, and ensure the test suite passes.

**Why selected:** Dual-task: security analysis AND code remediation. Natural split between analyst and implementer.

**Multi-agent hypothesis:** One agent performs thorough CWE-based security audit; another implements fixes. The reviewer can verify that fixes are correct and don't break functionality.

### Task 3: llm-inference-batching-scheduler

| Field | Value |
|---|---|
| Domain | ML / Systems |
| Difficulty | Hard |
| Expert time | 45 minutes |
| Resources | 1 CPU, 2GB RAM |

**Description:** Develop a shape-aware batching scheduler for LLM inference requests. Must satisfy alignment constraints, cost targets, padding ratio limits, and latency requirements across two request buckets. Max 8 unique shapes.

**Why selected:** Complex multi-constraint optimization with interacting variables. Benefits from exploring the constraint space.

**Multi-agent hypothesis:** One agent analyzes the constraint space and develops a strategy; another implements the optimizer. Different model perspectives may find different valid approaches to the shape-bucketing problem.

### Task 4: financial-document-processor

| Field | Value |
|---|---|
| Domain | Data processing |
| Difficulty | Medium |
| Expert time | 30 minutes |
| Resources | 1 CPU, 4GB RAM |

**Description:** Process a directory of mixed JPG/PDF documents: classify each as invoice or other, move to appropriate subdirectories, extract financial data (totals, VAT) via OCR, generate a summary CSV with aggregates.

**Why selected:** Multi-step pipeline requiring different skills: OCR/image processing, document classification, data extraction, CSV generation. Tests coordination.

**Multi-agent hypothesis:** One agent handles document classification and organization; another performs data extraction and aggregation. Pipeline tasks benefit from divide-and-conquer.

### Task 5: custom-memory-heap-crash

| Field | Value |
|---|---|
| Domain | Debugging |
| Difficulty | Medium |
| Expert time | 30 minutes |
| Resources | 1 CPU, 2GB RAM |

**Description:** Debug a C++ program that crashes in release mode but works in debug mode. The program uses a custom memory heap allocator. Fix only `user.cpp`. Must pass Valgrind (no memory leaks) in both build modes.

**Why selected:** Analysis-heavy debugging task. Requires understanding memory allocator behavior under optimization, identifying undefined behavior, and implementing a targeted fix.

**Multi-agent hypothesis:** One agent investigates the crash (runs the program, reads code, analyzes with Valgrind); another proposes and validates fixes. Two models may catch different classes of undefined behavior.

---

## 6. Evaluation Protocol

### Configurations

| Config | Agents | Model(s) |
|---|---|---|
| `baseline-claude` | 1 Claude Code | Opus 4.6 |
| `baseline-codex` | 1 Codex CLI | Default Codex model |
| `salon-multi` | Claude Code + Codex CLI via salon | Opus 4.6 + Codex default |

### Runs

- **5 runs per task per configuration** (minimum for 95% CI)
- Total: 5 tasks × 3 configs × 5 runs = **75 evaluations**
- Consider adding: `salon-same-model` (2× Claude Code) to isolate cross-model vs same-model effects

### Metrics

**Primary:** Resolution rate (% of tasks passed per configuration)

**Secondary:**
- Token usage (total input + output tokens across all agents)
- Wall-clock time per task
- Number of commands executed

### Running

```bash
# Install
pip install terminal-bench

# Single-agent baselines (built-in Claude Code agent)
tb run --agent claude-code --model anthropic/claude-opus-4-6 \
  --dataset terminal-bench-core==0.1.1 \
  --task-id protein-assembly \
  --n-runs 5

# Salon multi-agent (custom adapter)
tb run --agent-import-path salon_tbench.adapter:SalonAgent \
  --dataset terminal-bench-core==0.1.1 \
  --task-id protein-assembly \
  --n-runs 5
```

### Result analysis

For each configuration, compute:
- Pass rate ± stderr per task
- Aggregate pass rate ± stderr across all 5 tasks
- Token efficiency: tokens per successful task vs tokens per failed task
- Time comparison: does multi-agent take longer but succeed more?

---

## 7. Implementation Steps

### Step 1: Setup and verify Terminal-Bench

- Install `terminal-bench` and Docker
- Run the built-in `claude-code` agent on a single easy task (e.g., `kv-store-grpc` or `openssl-selfsigned-cert`) to verify the harness works
- Understand the `TmuxSession` API by reading terminal-bench source
- Estimated time: half a day

### Step 2: Implement single-agent baselines

- Verify that `tb run --agent claude-code` works for our 5 selected tasks
- If Codex CLI isn't a built-in agent, implement a `CodexAgent(AbstractInstalledAgent)` adapter
- Run single-task tests to establish baseline behavior
- Estimated time: 1-2 days

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

- Run all 3 configurations on all 5 tasks (75 evaluations)
- Monitor for flaky failures, timeouts, or adapter bugs
- Estimated time: 2-3 days (mostly wall-clock waiting)

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
- 1-4 CPUs, 2-8GB RAM per container (varies by task)
- `protein-assembly` needs 4GB; others need 2GB
- Can run tasks in parallel with `--n-concurrent` if hardware allows

### API costs

Per evaluation (one agent working on one task):
- Hard tasks (protein-assembly, fix-vulnerability, batching-scheduler): ~$2-5 in API tokens
- Medium tasks (financial-processor, heap-crash): ~$1-3 in API tokens
- Average: ~$3 per evaluation

For the full pilot:
- 75 evaluations × $3 average = **~$225 in API costs**
- With a same-model config added (100 evaluations): **~$300**

### Time

- Setup + baselines: 2-3 days
- Salon adapter: 3-5 days
- Running pilot: 2-3 days
- Analysis: 1 day
- **Total: ~2 weeks**

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

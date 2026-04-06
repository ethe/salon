# Terminal-Bench Pilot: Evaluating Salon Multi-Agent Collaboration

## Status

**Implemented.** Adapter built, first evaluation round completed (12 tasks, single run each). Preparing for full 5-run evaluation on x86.

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
- Tests are mounted ONLY after the agent phase completes — agents cannot access or run verification tests during execution
- **Scoring is binary pass/fail** — resolution rate (% of tasks passed) is the primary metric
- Results require minimum 5 runs per configuration for 95% confidence intervals

**Current top performance:** ~82% aggregate (ForgeCode with GPT-5.4 / Opus 4.6). Many individual tasks remain unsolved by any agent.

### Papers & links

- Repo: https://github.com/laude-institute/terminal-bench
- Paper: https://arxiv.org/abs/2601.11868
- Leaderboard: https://www.tbench.ai/leaderboard/terminal-bench/2.0
- Agent docs: https://www.tbench.ai/docs/agent-introduction

---

## 2. Architecture

### Chosen approach: subprocess launcher with direct container access

The adapter launches salon as a subprocess. Salon creates its own tmux session with a host pane and guest panes. Guests interact with the task container directly via `docker exec`, bypassing the Terminal-Bench `TmuxSession` proxy.

```
Terminal-Bench harness
    │
    ▼
SalonAgent.perform_task(instruction, session)
    │
    ├─ Extract container name from session.container.name
    ├─ Write task instruction to temp file
    ├─ Launch: node dist/main.js (salon launcher)
    │   └─ Creates tmux session: salon-tbench-<id>
    │       ├─ Pane 0: Host (pi + salon extension, Claude Opus 4.6)
    │       ├─ Pane 1: Codex CLI guest (executor)
    │       └─ Pane 2: Claude Code guest (reviewer)
    │
    ├─ Guests interact with container directly:
    │   docker exec $SALON_CONTAINER_ID bash -c '<command>'
    │   (No TmuxSession proxy — guests have full autonomous tool use)
    │
    ├─ Adapter polling loop:
    │   ├─ Check if result.json exists (written by finish_task)
    │   ├─ Monitor host pane liveness
    │   ├─ Take 60s snapshots for debugging
    │   ├─ On timeout: kill host, relaunch, guests survive
    │   └─ On session death: recover token usage from logs
    │
    └─ Return AgentResult (token counts, failure mode)
```

### Why this approach

We evaluated three architectures in the original proposal:

- **Architecture A (Host-as-executor):** Guests only advise, adapter translates to TmuxSession calls. Rejected — loses guest autonomy and makes host a bottleneck.
- **Architecture B (Tool call proxy):** Intercept guest tool calls and redirect through TmuxSession. Rejected — complex proxy layer, lossy tool translation.
- **Architecture C (Direct container access):** Guests use `docker exec` directly. **Chosen** — simplest to implement, preserves full guest autonomy, no salon core changes needed.

The key insight was that `docker exec` gives guests the same capabilities as `TmuxSession.send_keys()` but with better ergonomics (structured output, no terminal escape codes, parallel access).

---

## 3. Adapter Design

### Module structure

```
salon_tbench/
├── __init__.py          # Exports SalonAgent
├── adapter.py           # BaseAgent implementation (554 lines)
└── requirements.txt     # terminal-bench==0.2.18
```

### SalonAgent class

```python
class SalonAgent(BaseAgent):
    def __init__(
        self,
        soft_timeout_sec: int = 1200,
        completion_reserve_sec: int = 60,
        resume_window_sec: int = 600,
        **kwargs: Any,
    ) -> None: ...

    @staticmethod
    def name() -> str:
        return "salon"

    def perform_task(
        self,
        instruction: str,
        session: TmuxSession,
        logging_dir: Path | None = None,
    ) -> AgentResult: ...
```

### Timeout parameters

| Parameter | Default | Env override | Purpose |
|---|---|---|---|
| `soft_timeout_sec` | 1200 | `SALON_SOFT_TIMEOUT` | Total time budget for first window |
| `completion_reserve_sec` | 60 | — | Buffer subtracted from soft timeout |
| `resume_window_sec` | 600 | `SALON_RESUME_WINDOW` | Time budget per resume round |

### Completion detection

The host calls `finish_task` which writes `result.json` containing status, summary, and per-guest token usage. The adapter polls for this file every second.

If the host never writes `result.json` (crash, timeout, inference stall), the adapter returns `UNKNOWN_AGENT_ERROR` or `AGENT_TIMEOUT`. Terminal-Bench's harness runs tests regardless of failure mode — `is_resolved` is determined solely by whether all tests pass, independent of the agent's reported failure mode.

### Resume mechanism

When the first time window expires:
1. Adapter kills only the host pane (`Ctrl-C` + `exit`)
2. Guest panes survive (they're in separate tmux panes)
3. Adapter relaunches `node dist/main.js` in the host pane
4. Salon detects existing guest runtime files and reconstructs state
5. Host resumes coordination with a state summary

No cap on resume rounds — the terminal-bench harness enforces the hard timeout externally.

### Token usage recovery

When `result.json` is unavailable (timeout/crash), the adapter parses guest session logs directly:
- Claude Code: `~/.claude/projects/<slug>/<sessionId>.jsonl`
- Codex CLI: `~/.codex/sessions/<date>/rollout-*<sessionId>.jsonl`

---

## 4. Host Workflow (Autonomous Mode)

The host runs as a pi extension with an autonomous preamble that enforces a structured workflow:

### Step 0 — Planning via discuss (mandatory first action)

The host's first tool call must be `discuss` with the full task description verbatim. This invites two guests (codex + claude) who independently explore the task, then cross-review. The host does NOT analyze the task itself — host analysis is wasted because guests cannot see it.

### Step 1 — Assign executor, send plan brief

After discussion completes:
- **Executor:** Codex guest (better at implementation)
- **Reviewer:** Claude guest (better at analysis)

The executor receives the synthesized plan with constraints:
- Write artifacts to the task-specified path (not `/tmp/`)
- Write a first draft within 3-4 docker exec rounds
- Iterate: compile, test, fix

### Step 2 — Streaming review

When the executor reports done, the reviewer does streaming spot-checks. Each finding is reported immediately (no batching) so the host can forward to the executor in parallel.

### Step 3 — Streaming fix cycle

For each blocker found, the host sends two messages simultaneously:
1. Forward the blocker to the executor for fixing
2. Tell the reviewer to continue checking

Max 2 fix attempts per issue. If the executor self-verifies successfully, the host calls `finish_task` immediately without waiting for the reviewer.

### Hard limits

- First response must call `discuss` (no solo analysis)
- Max 2 fix-review cycles per issue
- Max 2 guests total
- Aim for `finish_task` within ~8 host turns
- Never cat large data files into context

---

## 5. Guest Configuration

### Executor (Codex CLI)

- Model: GPT-5.4 (configurable via `SALON_HOST_MODEL`)
- Reasoning effort: medium
- Container access: `docker exec $SALON_CONTAINER_ID bash -c '...'`
- Cannot use native Read/Edit/Grep — must use docker exec for everything

### Reviewer (Claude Code)

- Model: Claude Opus 4.6
- Reasoning effort: medium
- Same container access constraints as executor

### Guest brief

Both guests receive instructions to:
- Use `docker exec` exclusively (not native file tools)
- Never cat large data files without limiting output
- Check file sizes with `head`/`tail`/`wc -l` first

---

## 6. First Evaluation Results

### Configuration

Host: Claude Opus 4.6 (low effort) | Executor: Codex GPT-5.4 (medium) | Reviewer: Claude (medium)

### Results (single run per task)

| Task | ForgeCode GPT-5.4 | Salon | Notes |
|---|---|---|---|
| configure-git-webserver | 100% | ✅ | |
| model-extraction-relu-logits | 20% | ✅ | |
| fix-code-vulnerability | 0% | ✅ | ForgeCode 0%, salon solved |
| caffe-cifar-10 | 0% | ✅ | ForgeCode 0%, salon solved |
| mailman | 20% | ✅ | |
| filter-js-from-html | 0% | ❌ | |
| make-doom-for-mips | 0% | ❌ | Timeout |
| dna-insert | 0% | ❌ | DNA tokenization stall |
| raman-fitting | 0% | ❌ | |
| make-mips-interpreter | 0% | ⚠️ | Docker build failure (ARM) |
| break-filter-js-from-html | 40% | ⚠️ | Docker build failure (ARM) |
| largest-eigenval | 60% | ⚠️ | Solved but host didn't call finish_task |

**Notable:** Salon solved 3 tasks (fix-code-vulnerability, caffe-cifar-10, mailman) where ForgeCode GPT-5.4 scored 0-20%.

### Observed failure modes

1. **Claude inference stalls:** Host or reviewer gets stuck in "Churning" state for 10+ minutes during thinking. Root cause is inference service instability, not salon architecture.

2. **DNA tokenization:** Raw DNA sequences (long strings of A/T/G/C) cause severe inference degradation. Partially mitigated by guest brief warning against catting large data files.

3. **Docker build failures:** Some task containers only have amd64 images. Running on ARM causes build failures. Fix: use x86 machine.

4. **Host not calling finish_task:** Host can complete coordination but crash or time out before writing result.json. Not a scoring issue — terminal-bench tests run regardless of failure mode.

---

## 7. Running

### Prerequisites

```bash
# On the evaluation machine:
git clone https://github.com/ethe/salon.git
cd salon
npm install && npm run build
pip install terminal-bench==0.2.18
```

### Single task

```bash
tb run -d terminal-bench-core \
  --agent-import-path salon_tbench.adapter:SalonAgent \
  -t dna-assembly \
  --n-attempts 5
```

### Custom parameters

```bash
tb run -d terminal-bench-core \
  --agent-import-path salon_tbench.adapter:SalonAgent \
  -k soft_timeout_sec=1800 \
  -k completion_reserve_sec=60 \
  --n-attempts 5
```

### Resume interrupted run

```bash
tb runs resume --run-id <run-id>
```

### Full dataset

```bash
tb run -d terminal-bench-core \
  --agent-import-path salon_tbench.adapter:SalonAgent \
  --n-attempts 5 \
  --n-concurrent 2
```

### Submit to leaderboard

```bash
tb run -d terminal-bench-core \
  --agent-import-path salon_tbench.adapter:SalonAgent \
  --n-attempts 5 \
  --upload-results
```

---

## 8. Cost Estimate

Per salon evaluation (two agents collaborating on one task):
- Salon uses ~2-3× the tokens of a single agent (host + two guests)
- Estimated cost per trial: ~$2-5
- Average: ~$3.50 per evaluation

For full evaluation:
- 89 tasks × 5 runs = 445 evaluations
- Estimated total: ~$1,500-2,200

For targeted evaluation (selected tasks):
- 12 tasks × 5 runs = 60 evaluations
- Estimated total: ~$210

---

## 9. Known Limitations

1. **No test access during agent phase.** Terminal-bench mounts test files only after the agent completes. Agents must produce correct output without running verification tests. This favors agents with strong domain knowledge over agents that iterate via test feedback.

2. **Single-shot scoring.** Binary pass/fail doesn't capture partial progress or reasoning quality. A solution that's 95% correct scores the same as one that's 0% correct.

3. **Inference instability.** Claude Code's inference service occasionally stalls for extended periods (10+ minutes), consuming the time budget without progress. This is external to salon but significantly impacts results.

4. **Token overhead.** Multi-agent coordination (host + 2 guests + discussion phase) uses 2-3× more tokens than a single agent. The cost is justified only if resolution rate improves proportionally.

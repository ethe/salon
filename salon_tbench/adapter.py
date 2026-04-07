import asyncio
import json
import logging
import os
import re
import subprocess
import tempfile
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

logger = logging.getLogger(__name__)


def _sanitize_docker_compose_project_name(name: str) -> str:
	"""Mirror Harbor's project-name sanitisation so we can derive the container name."""
	name = name.lower()
	if not re.match(r"^[a-z0-9]", name):
		name = "0" + name
	name = re.sub(r"[^a-z0-9_-]", "-", name)
	return name


class SalonAgent(BaseAgent):
	def __init__(
		self,
		soft_timeout_sec: int = 1200,
		completion_reserve_sec: int = 60,
		resume_window_sec: int = 600,
		**kwargs: Any,
	) -> None:
		super().__init__(**kwargs)
		self._tmux_session_name: str | None = None
		self._salon_dir: Path | None = None
		self._host_pane_file: Path | None = None
		self._result_file: Path | None = None
		self._soft_timeout_sec = soft_timeout_sec
		self._completion_reserve_sec = completion_reserve_sec
		self._resume_window_sec = resume_window_sec

	@staticmethod
	def name() -> str:
		return "salon"

	def version(self) -> str | None:
		return "0.1.0"

	async def setup(self, environment: BaseEnvironment) -> None:
		# Salon runs on the host and reaches into the container via docker exec.
		# No in-container setup required.
		pass

	# ------------------------------------------------------------------
	# Helpers
	# ------------------------------------------------------------------

	def _effective_soft_timeout(self) -> int:
		configured_timeout = int(
			os.environ.get("SALON_SOFT_TIMEOUT", str(self._soft_timeout_sec))
		)
		return max(1, configured_timeout - self._completion_reserve_sec)

	@staticmethod
	def _container_name_from_environment(environment: BaseEnvironment) -> str:
		"""Derive the Docker container name that Harbor created for this trial."""
		project = _sanitize_docker_compose_project_name(environment.session_id)
		return f"{project}-main-1"

	# ------------------------------------------------------------------
	# Main entry point
	# ------------------------------------------------------------------

	async def run(
		self,
		instruction: str,
		environment: BaseEnvironment,
		context: AgentContext,
	) -> None:
		debug_path = self.logs_dir / "adapter_debug.log" if self.logs_dir else None

		def debug(message: str) -> None:
			if debug_path is None:
				return
			debug_path.parent.mkdir(parents=True, exist_ok=True)
			with debug_path.open("a", encoding="utf-8") as handle:
				handle.write(f"{message}\n")

		try:
			container_name = self._container_name_from_environment(environment)
			debug(f"run start logs_dir={self.logs_dir}")
			debug(f"container_name={container_name}")

			with tempfile.TemporaryDirectory(prefix="salon-tbench-") as tmpdir:
				tmpdir_path = Path(tmpdir)
				task_file = tmpdir_path / "task.md"
				result_file = tmpdir_path / "result.json"
				salon_dir = tmpdir_path / "salon-runtime"
				run_id = uuid.uuid4().hex[:8]
				salon_instance = f"tbench-{run_id}"
				tmux_session_name = f"salon-{salon_instance}"

				self._tmux_session_name = tmux_session_name
				self._salon_dir = salon_dir
				self._host_pane_file = result_file.parent / "host_pane.txt"
				self._result_file = result_file

				task_file.write_text(instruction, encoding="utf-8")
				debug(f"tmpdir={tmpdir_path}")
				debug(f"tmux_session_name={tmux_session_name}")

				repo_root = Path(__file__).resolve().parents[1]
				debug(f"repo_root={repo_root}")

				try:
					chmod_result = subprocess.run(
						["sudo", "chmod", "666", "/var/run/docker.sock"],
						capture_output=True,
						text=True,
						check=False,
					)
					debug(
						"docker_sock_chmod="
						f"returncode={chmod_result.returncode} "
						f"stdout={chmod_result.stdout.strip()!r} "
						f"stderr={chmod_result.stderr.strip()!r}"
					)
				except Exception as exc:
					debug(f"docker_sock_chmod_failed={exc}")

				env = {
					**os.environ,
					"SALON_AUTONOMOUS": "1",
					"SALON_TASK_FILE": str(task_file),
					"SALON_RESULT_FILE": str(result_file),
					"SALON_DIR": str(salon_dir),
					"SALON_INSTANCE": salon_instance,
					"SALON_CONTAINER_ID": container_name,
					"SALON_TMUX_SESSION": tmux_session_name,
				}
				launcher = subprocess.Popen(
					["node", "dist/main.js"],
					cwd=repo_root,
					env=env,
					stdout=subprocess.DEVNULL,
					stderr=subprocess.DEVNULL,
				)
				debug(f"launcher_pid={launcher.pid}")
				try:
					launcher.wait(timeout=120)
					debug(f"launcher_returncode={launcher.returncode}")
				except subprocess.TimeoutExpired:
					launcher.kill()
					launcher.wait(timeout=5)
					debug("launcher timeout waiting for exit")
					return

				configured_soft_timeout = int(
					os.environ.get("SALON_SOFT_TIMEOUT", str(self._soft_timeout_sec))
				)
				soft_timeout = self._effective_soft_timeout()
				resume_window = int(
					os.environ.get("SALON_RESUME_WINDOW", str(self._resume_window_sec))
				)
				debug(f"configured_soft_timeout={configured_soft_timeout}")
				debug(f"completion_reserve_sec={self._completion_reserve_sec}")
				debug(f"effective_soft_timeout={soft_timeout}")
				debug(f"resume_window={resume_window}")
				started_at = time.time()
				host_missing_since: float | None = None
				last_snapshot_time = started_at
				host_turn_count = 0
				nudge_sent = False
				hard_deadline = started_at + soft_timeout + resume_window

				while True:
					if result_file.exists():
						debug(f"result_file exists={result_file}")
						try:
							debug(f"result_file contents={result_file.read_text(encoding='utf-8')}")
						except Exception as exc:
							debug(f"failed to read result_file: {exc}")
						self._populate_context_from_result(result_file, context)
						return

					if not self._host_pane_alive():
						now = time.time()
						if host_missing_since is None:
							host_missing_since = now
							logger.warning("host pane not detected, starting 30s grace period")
							debug(f"host pane missing target={self._read_host_pane_target()}")
							debug(f"host_pane_file_exists={self._host_pane_file.exists() if self._host_pane_file else False}")
						elif now - host_missing_since > 30 and not self._salon_session_alive():
							session_check = subprocess.run(
								["tmux", "list-sessions", "-F", "#{session_name}"],
								capture_output=True,
								text=True,
								check=False,
							)
							debug(f"tmux_sessions={session_check.stdout.strip()}")
							self._populate_context_from_logs(context)
							debug(f"recovered context input={context.n_input_tokens} output={context.n_output_tokens}")
							return
					else:
						host_missing_since = None

					now = time.time()
					if now - last_snapshot_time >= 60:
						last_snapshot_time = now
						host_turn_count += 1
						host_pane_target = self._read_host_pane_target()
						if host_pane_target:
							try:
								snap = subprocess.run(
									["tmux", "capture-pane", "-t", host_pane_target, "-p"],
									capture_output=True,
									text=True,
									check=False,
								).stdout[-2000:]
								elapsed = int(now - started_at)
								logger.info("[t=%ss turn=%s] host pane snapshot:\n%s", elapsed, host_turn_count, snap)
								debug(f"[t={elapsed}s turn={host_turn_count}] host pane snapshot:\n{snap}")
							except Exception as exc:
								logger.warning("snapshot failed: %s", exc)
								debug(f"snapshot failed: {exc}")

					elapsed = time.time() - started_at

					# Soft nudge: send a time warning to the host
					if not nudge_sent and elapsed > soft_timeout:
						nudge_sent = True
						remaining = int(hard_deadline - time.time())
						debug(f"sending time nudge, {remaining}s remaining")
						self._nudge_host(remaining)

					# Hard deadline: kill everything
					if time.time() > hard_deadline:
						debug("hard deadline reached; killing salon session")
						self._kill_salon_session()
						self._populate_context_from_logs(context)
						debug(
							"timeout context="
							f"input={context.n_input_tokens} "
							f"output={context.n_output_tokens}"
						)
						return

					await asyncio.sleep(1)
		except Exception:
			import traceback

			if self.logs_dir:
				(self.logs_dir / "adapter_error.log").write_text(
					traceback.format_exc(), encoding="utf-8"
				)
			raise
		finally:
			self._kill_salon_session()

	# ------------------------------------------------------------------
	# Result parsing
	# ------------------------------------------------------------------

	def _populate_context_from_result(self, result_file: Path, context: AgentContext) -> None:
		data = json.loads(result_file.read_text(encoding="utf-8"))
		guests = data.get("guests", {})
		context.n_input_tokens = sum(int(guest.get("input_tokens", 0)) for guest in guests.values())
		context.n_output_tokens = sum(int(guest.get("output_tokens", 0)) for guest in guests.values())

	def _populate_context_from_logs(self, context: AgentContext) -> None:
		usage = self._try_parse_session_logs()
		context.n_input_tokens = usage.get("total_input_tokens", 0) or None
		context.n_output_tokens = usage.get("total_output_tokens", 0) or None

	# ------------------------------------------------------------------
	# Tmux helpers (unchanged from legacy adapter)
	# ------------------------------------------------------------------

	def _host_pane_alive(self) -> bool:
		host_pane_target = self._read_host_pane_target()
		if not host_pane_target:
			return False
		result = subprocess.run(
			["tmux", "display-message", "-p", "-t", host_pane_target, "#{pane_dead}"],
			capture_output=True,
			text=True,
			check=False,
		)
		if result.returncode != 0:
			return False
		return result.stdout.strip() == "0"

	def _read_host_pane_target(self) -> str | None:
		if self._host_pane_file and self._host_pane_file.exists():
			target = self._host_pane_file.read_text(encoding="utf-8").strip()
			if target:
				return target
		if self._tmux_session_name:
			return f"{self._tmux_session_name}:0.0"
		return None

	def _salon_session_alive(self) -> bool:
		if not self._tmux_session_name:
			return False
		result = subprocess.run(
			["tmux", "has-session", "-t", self._tmux_session_name],
			capture_output=True,
			text=True,
			check=False,
		)
		return result.returncode == 0

	def _kill_salon_session(self) -> None:
		if not self._tmux_session_name:
			return
		subprocess.run(
			["tmux", "kill-session", "-t", self._tmux_session_name],
			capture_output=True,
			text=True,
			check=False,
		)

	def _nudge_host(self, remaining_sec: int) -> None:
		"""Send a time warning to the host pane as a user message."""
		host_pane_target = self._read_host_pane_target()
		if not host_pane_target:
			return
		msg = (
			f"[HARNESS] WARNING: Only {remaining_sec}s remaining before hard timeout. "
			f"Call finish_task NOW with whatever state exists. "
			f"Do not start new work — submit what you have."
		)
		subprocess.run(
			["tmux", "send-keys", "-t", host_pane_target, "-l", msg],
			capture_output=True, text=True, check=False,
		)
		subprocess.run(
			["tmux", "send-keys", "-t", host_pane_target, "Enter"],
			capture_output=True, text=True, check=False,
		)

	# ------------------------------------------------------------------
	# Token usage recovery from session logs
	# ------------------------------------------------------------------

	def _try_parse_session_logs(self) -> dict[str, int]:
		total_input_tokens = 0
		total_output_tokens = 0

		if not self._salon_dir:
			return {"total_input_tokens": 0, "total_output_tokens": 0}

		guests_dir = self._salon_dir / "guests"
		if not guests_dir.exists():
			return {"total_input_tokens": 0, "total_output_tokens": 0}

		for runtime_file in sorted(guests_dir.glob("*.json")):
			try:
				runtime_data = json.loads(runtime_file.read_text(encoding="utf-8"))
			except Exception as exc:
				logger.warning("Failed to read guest runtime file %s: %s", runtime_file, exc)
				continue

			guest_type = runtime_data.get("type")
			session_id = runtime_data.get("sessionId")
			if not isinstance(guest_type, str) or not isinstance(session_id, str) or not session_id:
				continue

			try:
				if guest_type == "claude":
					log_path = self._resolve_claude_session_log_path(
						session_id, runtime_data.get("workspaceDir")
					)
					if not log_path:
						logger.warning("Claude session log not found for session %s", session_id)
						continue
					input_tokens, output_tokens = self._parse_claude_session_log(log_path)
				elif guest_type == "codex":
					started_at = self._parse_started_at(runtime_data.get("startedAt"))
					log_path = self._resolve_codex_session_log_path(session_id, started_at)
					if not log_path:
						logger.warning("Codex session log not found for session %s", session_id)
						continue
					input_tokens, output_tokens = self._parse_codex_session_log(log_path)
				else:
					continue
			except Exception as exc:
				logger.warning("Failed to parse %s session log for %s: %s", guest_type, session_id, exc)
				continue

			total_input_tokens += input_tokens
			total_output_tokens += output_tokens

		return {
			"total_input_tokens": total_input_tokens,
			"total_output_tokens": total_output_tokens,
		}

	def _resolve_claude_session_log_path(
		self,
		session_id: str,
		workspace_dir: Any,
	) -> Path | None:
		claude_root = Path.home() / ".claude"
		candidates: list[Path] = []

		if isinstance(workspace_dir, str) and workspace_dir:
			slug = workspace_dir.replace("/", "-").replace("\\", "-")
			candidates.append(claude_root / "projects" / slug / f"{session_id}.jsonl")

		sessions_dir = claude_root / "sessions"
		for meta_file in sessions_dir.glob("*.json"):
			try:
				meta = json.loads(meta_file.read_text(encoding="utf-8"))
			except Exception:
				continue
			if meta.get("sessionId") != session_id:
				continue
			cwd = meta.get("cwd")
			if isinstance(cwd, str) and cwd:
				slug = cwd.replace("/", "-").replace("\\", "-")
				candidates.append(claude_root / "projects" / slug / f"{session_id}.jsonl")

		for candidate in candidates:
			if candidate.exists():
				return candidate

		for candidate in (claude_root / "projects").rglob(f"{session_id}.jsonl"):
			return candidate
		return None

	def _resolve_codex_session_log_path(
		self, session_id: str, started_at: float | None
	) -> Path | None:
		codex_root = Path.home() / ".codex" / "sessions"
		for day_dir in self._candidate_codex_session_dirs(started_at):
			if not day_dir.exists():
				continue
			matches = sorted(day_dir.glob(f"rollout-*{session_id}.jsonl"))
			if matches:
				return matches[0]

		for candidate in codex_root.rglob(f"rollout-*{session_id}.jsonl"):
			return candidate
		return None

	def _candidate_codex_session_dirs(self, started_at: float | None) -> list[Path]:
		codex_root = Path.home() / ".codex" / "sessions"
		anchor = datetime.fromtimestamp(started_at or time.time())
		candidates: list[Path] = []
		for day_offset in (-1, 0, 1):
			date = anchor + timedelta(days=day_offset)
			candidates.append(codex_root / f"{date.year:04d}" / f"{date.month:02d}" / f"{date.day:02d}")
		return candidates

	def _parse_claude_session_log(self, log_path: Path) -> tuple[int, int]:
		total_input_tokens = 0
		total_output_tokens = 0
		seen_requests: set[str] = set()

		with log_path.open("r", encoding="utf-8") as handle:
			for line in handle:
				try:
					entry = json.loads(line)
				except json.JSONDecodeError:
					continue

				message = entry.get("message")
				if not isinstance(message, dict):
					continue
				usage = message.get("usage")
				if not isinstance(usage, dict):
					continue

				request_key = entry.get("requestId") or message.get("id") or entry.get("uuid")
				if request_key is not None:
					request_key = str(request_key)
					if request_key in seen_requests:
						continue
					seen_requests.add(request_key)

				total_input_tokens += self._safe_int(usage.get("input_tokens"))
				total_input_tokens += self._safe_int(usage.get("cache_read_input_tokens"))
				total_input_tokens += self._safe_int(usage.get("cache_creation_input_tokens"))
				total_output_tokens += self._safe_int(usage.get("output_tokens"))

		return total_input_tokens, total_output_tokens

	def _parse_codex_session_log(self, log_path: Path) -> tuple[int, int]:
		max_total_input_tokens = 0
		max_total_output_tokens = 0
		accumulated_input_tokens = 0
		accumulated_output_tokens = 0
		seen_last_usage: set[tuple[str, int, int]] = set()

		with log_path.open("r", encoding="utf-8") as handle:
			for line in handle:
				try:
					entry = json.loads(line)
				except json.JSONDecodeError:
					continue

				payload = entry.get("payload")
				if not isinstance(payload, dict) or payload.get("type") != "token_count":
					continue
				info = payload.get("info")
				if not isinstance(info, dict):
					continue

				total_usage = info.get("total_token_usage")
				if isinstance(total_usage, dict):
					max_total_input_tokens = max(
						max_total_input_tokens,
						self._safe_int(total_usage.get("input_tokens")),
					)
					max_total_output_tokens = max(
						max_total_output_tokens,
						self._safe_int(total_usage.get("output_tokens")),
					)
					continue

				last_usage = info.get("last_token_usage")
				if not isinstance(last_usage, dict):
					continue
				input_tokens = self._safe_int(last_usage.get("input_tokens"))
				output_tokens = self._safe_int(last_usage.get("output_tokens"))
				signature = (str(entry.get("timestamp", "")), input_tokens, output_tokens)
				if signature in seen_last_usage:
					continue
				seen_last_usage.add(signature)
				accumulated_input_tokens += input_tokens
				accumulated_output_tokens += output_tokens

		if max_total_input_tokens > 0 or max_total_output_tokens > 0:
			return max_total_input_tokens, max_total_output_tokens
		return accumulated_input_tokens, accumulated_output_tokens

	def _parse_started_at(self, value: Any) -> float | None:
		if not isinstance(value, str) or not value:
			return None
		try:
			return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
		except ValueError:
			return None

	def _safe_int(self, value: Any) -> int:
		if isinstance(value, bool):
			return 0
		if isinstance(value, int):
			return value
		if isinstance(value, float):
			return int(value)
		if isinstance(value, str):
			try:
				return int(value)
			except ValueError:
				return 0
		return 0

from __future__ import annotations

import base64
import json
import re
import shlex
import socketserver
import textwrap
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from terminal_bench.terminal.tmux_session import TmuxSession

_DEFAULT_EXEC_TIMEOUT_SEC = 120
_DEFAULT_IO_TIMEOUT_SEC = 30
_MAX_EXEC_OUTPUT_CHARS = 15000
_POLL_INTERVAL_SEC = 0.1
_START_MARKER_PREFIX = "__SALON_TB_START__"
_END_MARKER_PREFIX = "__SALON_TB_END__"


class _ThreadingUnixStreamServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
	daemon_threads = True
	allow_reuse_address = True


class TerminalBroker:
	def __init__(self, session: TmuxSession, sock_path: str):
		self._session = session
		self._sock_path = Path(sock_path)
		self._terminal_lock = threading.Lock()
		self._server: _ThreadingUnixStreamServer | None = None
		self._thread: threading.Thread | None = None

	def start(self) -> None:
		if self._server is not None:
			return

		self._sock_path.parent.mkdir(parents=True, exist_ok=True)
		if self._sock_path.exists() or self._sock_path.is_socket():
			self._sock_path.unlink()

		broker = self

		class Handler(socketserver.StreamRequestHandler):
			def handle(self) -> None:
				response = broker._handle_connection(self.rfile.readline())
				payload = (json.dumps(response, ensure_ascii=False) + "\n").encode("utf-8")
				self.wfile.write(payload)

		self._server = _ThreadingUnixStreamServer(str(self._sock_path), Handler)
		self._thread = threading.Thread(
			target=self._server.serve_forever,
			name="salon-terminal-broker",
			daemon=True,
		)
		self._thread.start()

	def stop(self) -> None:
		server = self._server
		thread = self._thread
		self._server = None
		self._thread = None

		if server is not None:
			server.shutdown()
			server.server_close()
		if thread is not None:
			thread.join(timeout=5)
		self._sock_path.unlink(missing_ok=True)

	def _handle_connection(self, raw_request: bytes) -> dict[str, Any]:
		if not raw_request:
			return {"error": "Empty request"}

		try:
			request = json.loads(raw_request.decode("utf-8"))
		except json.JSONDecodeError as exc:
			return {"error": f"Invalid JSON request: {exc}"}

		if not isinstance(request, dict):
			return {"error": "Request must be a JSON object"}

		try:
			command = request.get("cmd")
			if command == "exec":
				args = self._require_string(request, "args")
				timeout = self._coerce_timeout(request.get("timeout", _DEFAULT_EXEC_TIMEOUT_SEC))
				return self._execute_cmd(args=args, timeout=timeout)
			if command == "read":
				path = self._require_string(request, "path")
				return self._read_file(path)
			if command == "write":
				path = self._require_string(request, "path")
				content = self._require_string(request, "content")
				return self._write_file(path, content)
			if command == "ls":
				path = self._require_string(request, "path")
				return self._list_path(path)
			return {"error": f"Unsupported command: {command!r}"}
		except Exception as exc:  # pragma: no cover - defensive path
			return {"error": str(exc)}

	def _execute_cmd(
		self,
		args: str,
		timeout: int,
		max_output_chars: int | None = _MAX_EXEC_OUTPUT_CHARS,
	) -> dict[str, Any]:
		token = uuid.uuid4().hex
		start_marker = f"{_START_MARKER_PREFIX}:{token}"
		end_prefix = f"{_END_MARKER_PREFIX}:{token}"
		end_pattern = re.compile(rf"{re.escape(end_prefix)}:(?P<exit_code>-?\d+)")
		wrapped_command = self._wrap_exec_command(args, start_marker, end_prefix)

		with self._terminal_lock:
			self._session.send_keys([wrapped_command, "Enter"], block=False)
			buffer = ""
			deadline = time.monotonic() + timeout

			while time.monotonic() < deadline:
				chunk = self._normalize_terminal_output(self._session.get_incremental_output())
				buffer = self._append_output(buffer, chunk)
				match = end_pattern.search(buffer)
				if match is not None:
					output = self._extract_command_output(buffer, start_marker, match.start())
					return {
						"output": self._truncate_output(output, max_output_chars),
						"exit_code": int(match.group("exit_code")),
					}
				time.sleep(_POLL_INTERVAL_SEC)

			self._interrupt_session()
			partial_output = self._extract_command_output(buffer, start_marker, None)
			return {
				"output": self._truncate_output(partial_output, max_output_chars),
				"exit_code": 124,
				"error": f"Command timed out after {timeout} seconds",
			}

	def _read_file(self, path: str) -> dict[str, Any]:
		result = self._execute_cmd(
			args=f"cat -- {shlex.quote(path)}",
			timeout=_DEFAULT_IO_TIMEOUT_SEC,
			max_output_chars=None,
		)
		if int(result.get("exit_code", 1)) != 0:
			return self._as_error_response(f"Failed to read file: {path}", result)
		return {"content": str(result.get("output", ""))}

	def _write_file(self, path: str, content: str) -> dict[str, Any]:
		directory = str(Path(path).parent)
		if not directory:
			directory = "."

		if content:
			encoded = base64.b64encode(content.encode("utf-8")).decode("ascii")
			wrapped_payload = "\n".join(textwrap.wrap(encoded, width=76))
			delimiter = f"__SALON_TB_PAYLOAD_{uuid.uuid4().hex}__"
			command = (
				f"mkdir -p -- {shlex.quote(directory)} && "
				f"base64 -d > {shlex.quote(path)} <<'{delimiter}'\n"
				f"{wrapped_payload}\n"
				f"{delimiter}"
			)
		else:
			command = f"mkdir -p -- {shlex.quote(directory)} && : > {shlex.quote(path)}"

		result = self._execute_cmd(
			args=command,
			timeout=_DEFAULT_IO_TIMEOUT_SEC,
			max_output_chars=None,
		)
		if int(result.get("exit_code", 1)) != 0:
			return self._as_error_response(f"Failed to write file: {path}", result)
		return {"output": "", "exit_code": 0}

	def _list_path(self, path: str) -> dict[str, Any]:
		result = self._execute_cmd(
			args=f"ls -la -- {shlex.quote(path)}",
			timeout=_DEFAULT_IO_TIMEOUT_SEC,
		)
		if int(result.get("exit_code", 1)) != 0:
			return self._as_error_response(f"Failed to list path: {path}", result)
		return result

	def _wrap_exec_command(self, args: str, start_marker: str, end_prefix: str) -> str:
		return (
			f"printf '%s\\n' {shlex.quote(start_marker)}; "
			f"eval -- {shlex.quote(args)}; "
			"__salon_tb_rc=$?; "
			f"printf '\\n%s:%s\\n' {shlex.quote(end_prefix)} \"$__salon_tb_rc\""
		)

	def _interrupt_session(self) -> None:
		for _ in range(2):
			self._session.send_keys(["C-c"], block=False, min_timeout_sec=0.1)
		try:
			self._normalize_terminal_output(self._session.get_incremental_output())
		except Exception:
			return

	def _extract_command_output(
		self,
		buffer: str,
		start_marker: str,
		end_index: int | None,
	) -> str:
		start_index = buffer.find(start_marker)
		if start_index >= 0:
			output_start = start_index + len(start_marker)
			if output_start < len(buffer) and buffer[output_start:output_start + 1] == "\n":
				output_start += 1
		else:
			output_start = 0

		if end_index is None:
			relevant = buffer[output_start:]
		else:
			relevant = buffer[output_start:end_index]
		return relevant

	def _append_output(self, existing: str, chunk: str) -> str:
		if not chunk:
			return existing
		max_overlap = min(len(existing), len(chunk))
		for overlap in range(max_overlap, 0, -1):
			if existing.endswith(chunk[:overlap]):
				return existing + chunk[overlap:]
		return existing + chunk

	def _normalize_terminal_output(self, raw_output: str) -> str:
		for prefix in ("New Terminal Output:\n", "Current Terminal Screen:\n"):
			if raw_output.startswith(prefix):
				raw_output = raw_output[len(prefix):]
				break
		return raw_output.replace("\r\n", "\n").replace("\r", "\n")

	def _truncate_output(self, output: str, max_output_chars: int | None) -> str:
		if max_output_chars is None or len(output) <= max_output_chars:
			return output
		marker = f"\n... output truncated ({len(output) - max_output_chars} chars omitted) ...\n"
		remaining = max_output_chars - len(marker)
		if remaining <= 0:
			return output[:max_output_chars]
		head = remaining // 2
		tail = remaining - head
		return output[:head] + marker + output[-tail:]

	def _require_string(self, request: dict[str, Any], key: str) -> str:
		value = request.get(key)
		if not isinstance(value, str):
			raise ValueError(f"Request field '{key}' must be a string")
		return value

	def _coerce_timeout(self, value: Any) -> int:
		try:
			timeout = int(value)
		except (TypeError, ValueError) as exc:
			raise ValueError("timeout must be an integer") from exc
		if timeout <= 0:
			raise ValueError("timeout must be positive")
		return timeout

	def _as_error_response(self, message: str, result: dict[str, Any]) -> dict[str, Any]:
		output = str(result.get("output", ""))
		exit_code = int(result.get("exit_code", 1))
		return {"error": f"{message} (exit {exit_code})", "exit_code": exit_code, "output": output}

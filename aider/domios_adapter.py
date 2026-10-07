"""Authoritative completion for aider-chat 0.86.2. No Domios tool execution.

The IO object is the context identity: /ask and architect share it with their
nested coders. History stays Aider-owned; only this process writes the sidecar.
"""
import functools
import importlib.metadata
import inspect
import json
import os
from pathlib import Path
import sys
import uuid

SUPPORTED_VERSION = "0.86.2"


class AdapterError(RuntimeError):
    pass


class TurnState:
    def __init__(self, io, session, generation):
        self.io = io
        self.path = Path(io.chat_history_file).absolute()
        if self.path.stem != session:
            raise AdapterError("history basename must equal DOMIOS_AIDER_SESSION_ID")
        if str(io.encoding).lower().replace("-", "") != "utf8":
            raise AdapterError("relay history requires UTF-8 encoding")
        self.session = session
        self.generation = generation
        self.sequence = 0
        self.depth = 0
        self.pending = None
        self.active = None
        self.write({"kind": "adapter_start", "aiderVersion": SUPPORTED_VERSION})

    def write(self, record):
        record = {"version": 1, "sessionId": self.session,
                  "launchMarker": self.session, "processGeneration": self.generation, **record}
        sidecar = Path(str(self.path) + ".domios-turns.jsonl")
        sidecar.parent.mkdir(parents=True, exist_ok=True)
        # Binary prevents newline translation; a truncated last line is ignored.
        with sidecar.open("ab") as stream:
            stream.write((json.dumps(record, ensure_ascii=True, separators=(",", ":")) + "\n").encode("utf-8"))
            stream.flush()
            os.fsync(stream.fileno())

    def size(self):
        if self.io.chat_history_file is None or Path(self.io.chat_history_file).absolute() != self.path:
            raise AdapterError("Aider disabled or changed its history file")
        return self.path.stat().st_size if self.path.exists() else 0


def validate_api(Coder, IO, main, Commands, ArchitectCoder):
    """Refuse drift rather than emit speculative completion on a new release."""
    if importlib.metadata.version("aider-chat") != SUPPORTED_VERSION:
        raise AdapterError("requires exactly aider-chat==" + SUPPORTED_VERSION)
    expected = [
        (Coder.run_one, "(self, user_message, preproc)"),
        (Coder.run, "(self, with_message=None, preproc=True)"),
        (Coder.send, "(self, messages, model=None, functions=None)"),
        (Coder.send_message, "(self, inp)"),
        (Coder.keyboard_interrupt, "(self)"),
        (IO.user_input, "(self, inp, log_only=True)"),
        (IO.ai_output, "(self, content)"),
        (IO.tool_error, "(self, message='', strip=True)"),
        (IO.append_chat_history, "(self, text, linebreak=False, blockquote=False, strip=True)"),
        (main, "(argv=None, input=None, output=None, force_git_root=None, return_coder=False)"),
        (Commands._generic_chat_command, "(self, args, edit_format, placeholder=None)"),
        (ArchitectCoder.reply_completed, "(self)"),
    ]
    for fn, signature in expected:
        if str(inspect.signature(fn)) != signature:
            raise AdapterError("unsupported Aider signature: " + fn.__qualname__)
    # Subclasses must inherit the one boundary being wrapped.
    def check_subclasses(cls):
        for child in cls.__subclasses__():
            if "run_one" in child.__dict__ or "send_message" in child.__dict__ or "send" in child.__dict__:
                raise AdapterError("unsupported Aider boundary override: " + child.__name__)
            check_subclasses(child)
    check_subclasses(Coder)


def install(Coder, IO, SwitchCoder, session, generation=None):
    """Patch a validated API; also used with fake Coder/IO in unit tests."""
    generation = generation or uuid.uuid4().hex
    originals = []

    def patch(cls, name, factory):
        original = getattr(cls, name)
        originals.append((cls, name, original))
        setattr(cls, name, functools.wraps(original)(factory(original)))

    def state(io):
        return getattr(io, "_domios_turn_state", None)

    def io_init(original):
        def wrapped(io, *args, **kwargs):
            original(io, *args, **kwargs)
            if io.chat_history_file is not None:
                io._domios_turn_state = TurnState(io, session, generation)
        return wrapped

    def user_input(original):
        def wrapped(io, inp, *args, **kwargs):
            ctx = state(io)
            before = ctx.size() if ctx else 0
            result = original(io, inp, *args, **kwargs)
            if ctx and ctx.depth == 0:
                added = ctx.path.read_bytes()[before:ctx.size()]
                heading = added.find(b"#### ")
                if heading < 0 or (heading and added[heading - 1] != 10):
                    raise AdapterError("original user history heading was not written")
                ctx.pending = before + heading
            return result
        return wrapped

    def ai_output(original):
        def wrapped(io, content):
            ctx = state(io)
            before = ctx.size() if ctx and ctx.active else None
            result = original(io, content)
            if before is not None:
                first = ctx.active["response"]
                ctx.active["response"] = (first[0] if first else before, ctx.size())
            return result
        return wrapped

    def tool_error(original):
        def wrapped(io, *args, **kwargs):
            ctx = state(io)
            if ctx and ctx.active:
                ctx.active["error"] = True
            return original(io, *args, **kwargs)
        return wrapped

    def keyboard_interrupt(original):
        def wrapped(coder, *args, **kwargs):
            ctx = state(coder.io)
            if ctx and ctx.active:
                ctx.active["cancelled"] = True
            return original(coder, *args, **kwargs)
        return wrapped

    def send(original):
        def wrapped(coder, *args, **kwargs):
            ctx = state(coder.io)
            turn = ctx.active if ctx else None
            if turn:
                # A successful retry supersedes the previous attempt's error.
                turn["error"] = False
                turn["send_ok"] = False
            try:
                yield from original(coder, *args, **kwargs)
                if turn:
                    turn["send_ok"] = not turn["error"]
            except KeyboardInterrupt:
                if turn:
                    turn["cancelled"] = True
                raise
            except BaseException as err:
                if turn:
                    turn["error"] = True
                    # Aider may continue a length-limited answer with assistant
                    # prefill. Keep its preceding range, but discard failed
                    # retry partials before a later successful attempt.
                    if type(err).__name__ != "FinishReasonLength":
                        turn["response"] = None
                raise
        return wrapped

    def send_message(original):
        def wrapped(coder, *args, **kwargs):
            ctx = state(coder.io)
            turn = ctx.active if ctx else None
            if turn:
                turn["send_ok"] = False
                turn["response"] = None
            yield from original(coder, *args, **kwargs)
            if turn and not turn["send_ok"]:
                turn["error"] = True
        return wrapped

    def run_one(original):
        def wrapped(coder, *args, **kwargs):
            ctx = state(coder.io)
            if not ctx:
                raise AdapterError("no adapter history context")
            outer = ctx.depth == 0
            if outer:
                if ctx.pending is None:
                    raise AdapterError("run_one has no original user record")
                ctx.active = {"user": ctx.pending, "response": None, "error": False,
                              "cancelled": False, "limit": False, "nested": 0, "send_ok": False}
                ctx.pending = None
            else:
                ctx.active["nested"] += 1
            ctx.depth += 1
            try:
                return original(coder, *args, **kwargs)
            except SwitchCoder:
                # /ask returns by SwitchCoder *after* its nested run. A bare
                # mode switch has no response and never yields answered.
                if not ctx.active["nested"]:
                    ctx.active["error"] = True
                raise
            except KeyboardInterrupt:
                ctx.active["cancelled"] = True
                raise
            except BaseException:
                ctx.active["error"] = True
                raise
            finally:
                turn = ctx.active
                if getattr(coder, "reflected_message", None) and getattr(coder, "num_reflections", 0) >= getattr(coder, "max_reflections", 3):
                    turn["limit"] = True
                ctx.depth -= 1
                if outer:
                    try:
                        outcome = ("cancelled" if turn["cancelled"] else "reflection_limit" if turn["limit"]
                                   else "error" if turn["error"] or turn["response"] is None else "answered")
                        ctx.sequence += 1
                        start, end = turn["response"] or (ctx.size(), ctx.size())
                        ctx.write({"kind": "turn_complete", "turnSequence": ctx.sequence,
                                   "userRecordStart": turn["user"], "responseRecordStart": start,
                                   "responseRecordEnd": end, "historyBytes": ctx.size(),
                                   "outcome": outcome, "complete": outcome == "answered"})
                    finally:
                        ctx.active = None
        return wrapped

    patch(IO, "__init__", io_init)
    patch(IO, "user_input", user_input)
    patch(IO, "ai_output", ai_output)
    patch(IO, "tool_error", tool_error)
    patch(Coder, "keyboard_interrupt", keyboard_interrupt)
    patch(Coder, "send", send)
    patch(Coder, "send_message", send_message)
    patch(Coder, "run_one", run_one)

    def restore():
        for cls, name, fn in reversed(originals):
            setattr(cls, name, fn)
    return restore


def main():
    try:
        from aider.coders.base_coder import Coder
        from aider.coders.architect_coder import ArchitectCoder
        from aider.commands import Commands, SwitchCoder
        from aider.io import InputOutput
        from aider.main import main as aider_main
        validate_api(Coder, InputOutput, aider_main, Commands, ArchitectCoder)
        session = os.environ.get("DOMIOS_AIDER_SESSION_ID", "")
        if not session or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for char in session):
            raise AdapterError("missing or invalid DOMIOS_AIDER_SESSION_ID")
        install(Coder, InputOutput, SwitchCoder, session)
        return aider_main()
    except (AdapterError, ImportError, importlib.metadata.PackageNotFoundError) as err:
        print("Domios Aider adapter refused launch: " + str(err) +
              ". Install aider-chat==0.86.2 with uv tool or pipx, or explicitly set plainMode=true.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())

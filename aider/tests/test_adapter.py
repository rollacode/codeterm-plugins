"""Offline proofs against fake Coder/IO with the pinned control flow."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("domios_adapter", Path(__file__).parents[1] / "domios_adapter.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class SwitchCoder(Exception):
    pass


class FakeIO:
    def __init__(self, path, steps=None, encoding="utf-8", newline=None):
        self.chat_history_file = Path(path)
        self.encoding = encoding
        self.steps = list(steps or [])
        self.newline = newline
        self.observe = None
        self.append_chat_history("# aider chat started at fixture\n")

    def append_chat_history(self, text, linebreak=False, blockquote=False, strip=True):
        if linebreak:
            text = text.rstrip() + "  \n"
        if not text.endswith("\n"):
            text += "\n"
        with self.chat_history_file.open("a", encoding=self.encoding, newline=self.newline) as stream:
            stream.write(text)

    def user_input(self, inp, log_only=True):
        self.append_chat_history("\n#### " + "  \n#### ".join(inp.splitlines()), linebreak=True)

    def ai_output(self, content):
        self.append_chat_history("\n" + content.strip() + "\n\n")

    def tool_error(self, message="", strip=True):
        self.append_chat_history("> Error: " + message)


class FakeCoder:
    max_reflections = 3

    def __init__(self, io):
        self.io = io
        self.reflected_message = None
        self.num_reflections = 0

    def run(self, with_message=None, preproc=True):
        self.io.user_input(with_message)
        self.run_one(with_message, preproc)

    def keyboard_interrupt(self):
        pass

    def run_one(self, user_message, preproc):
        self.reflected_message = None
        self.num_reflections = 0
        if preproc and user_message.startswith("/ask "):
            FakeCoder(self.io).run(user_message[5:])
            raise SwitchCoder()
        while user_message:
            self.reflected_message = None
            list(self.send_message(user_message))
            if not self.reflected_message:
                break
            if self.num_reflections >= self.max_reflections:
                return
            self.num_reflections += 1
            user_message = self.reflected_message

    def send_message(self, inp):
        step = self.io.steps.pop(0)
        self.step = step
        try:
            yield from self.send([])
        except KeyboardInterrupt:
            return  # Aider catches this internally too.
        except RuntimeError:
            if step.get("swallow"):
                self.io.tool_error("swallowed API failure")
                return
            raise
        self.reflected_message = step.get("reflect")
        if step.get("architect"):
            FakeCoder(self.io).run("internal editor instruction", preproc=False)
        if self.io.observe:
            self.io.observe()

    def send(self, messages, model=None, functions=None):
        step = self.step
        if step.get("answer"):
            self.io.ai_output(step["answer"])
        if step.get("cancel"):
            raise KeyboardInterrupt()
        if step.get("error"):
            raise RuntimeError("API failure")
        yield "chunk"


class FakeArchitect(FakeCoder):
    def reply_completed(self):
        pass


class FakeCommands:
    def _generic_chat_command(self, args, edit_format, placeholder=None):
        pass


def fake_main(argv=None, input=None, output=None, force_git_root=None, return_coder=False):
    pass


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "ct-launch-test.md"
        self.restore = adapter.install(FakeCoder, FakeIO, SwitchCoder, "ct-launch-test", "generation-test")
        self.addCleanup(self.restore)

    def records(self):
        return [json.loads(line) for line in Path(str(self.path) + ".domios-turns.jsonl").read_text().splitlines()]

    def run_turn(self, steps, prompt="hello", **kwargs):
        io = FakeIO(self.path, steps, **kwargs)
        coder = FakeCoder(io)
        coder.run(prompt)
        return io, self.records()[-1]

    def test_start_is_visible_before_any_turn(self):
        FakeIO(self.path)
        self.assertEqual(self.records(), [{"version": 1, "kind": "adapter_start", "sessionId": "ct-launch-test",
                         "launchMarker": "ct-launch-test", "processGeneration": "generation-test", "aiderVersion": "0.86.2"}])

    def test_start_is_fsynced_before_first_history_header_write(self):
        original = FakeIO.append_chat_history.__wrapped__
        def observe(io, *args, **kwargs):
            self.assertFalse(self.path.exists())
            self.assertEqual(self.records()[0]["kind"], "adapter_start")
            return original(io, *args, **kwargs)
        # Intercept the original append under the adapter wrapper, not after it.
        self.restore()
        with patch.object(FakeIO, "append_chat_history", observe):
            restore = adapter.install(FakeCoder, FakeIO, SwitchCoder, "ct-launch-test", "generation-test")
            try:
                FakeIO(self.path)
            finally:
                restore()

    def test_single_answer_boundaries_are_actual_bytes(self):
        _, end = self.run_turn([{"answer": "Final ✓"}], "question é", newline="\r\n")
        raw = self.path.read_bytes()
        self.assertEqual(end["outcome"], "answered")
        self.assertTrue(end["complete"])
        self.assertTrue(raw[end["userRecordStart"]:].startswith(b"#### question \xc3\xa9"))
        self.assertEqual(raw[end["responseRecordStart"]:end["responseRecordEnd"]].decode(), "\r\nFinal ✓\r\n\r\n")
        self.assertEqual(end["historyBytes"], len(raw))

    def test_file_add_reflections_only_publish_final_answer(self):
        io = FakeIO(self.path, [{"answer": "read a.py", "reflect": "Added a.py"},
                                {"answer": "read b.py", "reflect": "Added b.py"}, {"answer": "Grounded final"}])
        io.observe = lambda: self.assertEqual(len(self.records()), 1)
        FakeCoder(io).run("review")
        self.assertEqual(len(self.records()), 2)
        end = self.records()[-1]
        self.assertEqual(self.path.read_bytes()[end["responseRecordStart"]:end["responseRecordEnd"]].strip(), b"Grounded final")

    def test_ask_keeps_original_user_and_one_completion(self):
        io = FakeIO(self.path, [{"answer": "ask final"}])
        with self.assertRaises(SwitchCoder):
            FakeCoder(io).run("/ask inspect")
        records = self.records()
        self.assertEqual(len(records), 2)
        self.assertEqual(records[-1]["outcome"], "answered")
        self.assertTrue(self.path.read_bytes()[records[-1]["userRecordStart"]:].startswith(b"#### /ask inspect"))

    def test_architect_shared_io_editor_only_publishes_outer_completion(self):
        io = FakeIO(self.path, [{"answer": "plan", "architect": True}, {"answer": "editor result"}])
        io.observe = lambda: self.assertEqual(len(self.records()), 1)
        FakeCoder(io).run("implement")
        end = self.records()[-1]
        self.assertEqual(end["outcome"], "answered")
        self.assertTrue(self.path.read_bytes()[end["userRecordStart"]:].startswith(b"#### implement"))
        self.assertEqual(self.path.read_bytes()[end["responseRecordStart"]:end["responseRecordEnd"]].strip(), b"editor result")

    def test_error_propagating_does_not_publish_partial_answer(self):
        io = FakeIO(self.path, [{"answer": "partial", "error": True}])
        with self.assertRaises(RuntimeError):
            FakeCoder(io).run("question")
        self.assertEqual(self.records()[-1]["outcome"], "error")
        self.assertFalse(self.records()[-1]["complete"])

    def test_swallowed_error_does_not_publish_partial_answer(self):
        _, end = self.run_turn([{"answer": "partial", "error": True, "swallow": True}])
        self.assertEqual(end["outcome"], "error")
        self.assertFalse(end["complete"])

    def test_swallowed_keyboard_interrupt_is_cancelled(self):
        _, end = self.run_turn([{"answer": "partial", "cancel": True}])
        self.assertEqual(end["outcome"], "cancelled")
        self.assertFalse(end["complete"])

    def test_reflection_limit_is_not_success(self):
        _, end = self.run_turn([{"answer": str(n), "reflect": "more"} for n in range(4)])
        self.assertEqual(end["outcome"], "reflection_limit")
        self.assertFalse(end["complete"])

    def test_empty_turn_is_error(self):
        _, end = self.run_turn([{}])
        self.assertEqual(end["outcome"], "error")

    def test_original_identity_and_sequence_survive_multiple_turns(self):
        io = FakeIO(self.path, [{"answer": "a"}, {"answer": "b"}])
        coder = FakeCoder(io)
        coder.run("same")
        coder.run("same")
        first, second = self.records()[1:]
        self.assertLess(first["userRecordStart"], second["userRecordStart"])
        self.assertEqual([first["turnSequence"], second["turnSequence"]], [1, 2])

    def test_restart_appends_generation_without_replaying_completed_turns(self):
        self.run_turn([{"answer": "First answer"}], "Original brief é", newline="\r\n")
        original_history = self.path.read_bytes()
        original_records = self.records()
        self.restore()
        restore = adapter.install(FakeCoder, FakeIO, SwitchCoder, "ct-launch-test", "generation-resumed")
        self.addCleanup(restore)
        io = FakeIO(self.path, [{"answer": "Followup answer"}], newline="\r\n")
        self.assertTrue(self.path.read_bytes().startswith(original_history))
        records = self.records()
        self.assertEqual(records[:-1], original_records)
        self.assertEqual(records[-1]["kind"], "adapter_start")
        self.assertEqual(records[-1]["processGeneration"], "generation-resumed")
        self.assertIsNone(io._domios_turn_state.pending)
        # Loading model context reads history; it must not log old input again.
        self.path.read_text(encoding="utf-8")
        self.assertEqual(self.records(), records)
        FakeCoder(io).run("Followup")
        ends = [record for record in self.records() if record["kind"] == "turn_complete"]
        self.assertEqual(len(ends), 2)
        self.assertEqual(ends[0], original_records[-1])
        self.assertEqual([end["turnSequence"] for end in ends], [1, 1])
        self.assertEqual(ends[1]["processGeneration"], "generation-resumed")
        self.assertGreaterEqual(ends[1]["userRecordStart"], len(original_history))
        raw = self.path.read_bytes()
        self.assertEqual(raw.count(b"Original brief"), 1)
        self.assertEqual(raw.count(b"#### Followup"), 1)
        self.assertIn(b"Followup answer", raw[ends[1]["responseRecordStart"]:ends[1]["responseRecordEnd"]])

    def test_restart_does_not_invent_completion_for_interrupted_old_input(self):
        io = FakeIO(self.path)
        io.user_input("Unfinished brief")
        old_bytes = self.path.read_bytes()
        self.restore()
        restore = adapter.install(FakeCoder, FakeIO, SwitchCoder, "ct-launch-test", "generation-resumed")
        self.addCleanup(restore)
        resumed = FakeIO(self.path, [{"answer": "New answer"}])
        self.assertEqual([record["kind"] for record in self.records()], ["adapter_start", "adapter_start"])
        FakeCoder(resumed).run("New input")
        ends = [record for record in self.records() if record["kind"] == "turn_complete"]
        self.assertEqual(len(ends), 1)
        self.assertGreaterEqual(ends[0]["userRecordStart"], len(old_bytes))
        self.assertEqual(ends[0]["processGeneration"], "generation-resumed")

    def test_other_session_refuses_before_start_record(self):
        with self.assertRaisesRegex(adapter.AdapterError, "basename"):
            FakeIO(Path(self.tmp.name) / "wrong.md")

    def test_non_utf8_refuses(self):
        with self.assertRaisesRegex(adapter.AdapterError, "UTF-8"):
            FakeIO(self.path, encoding="latin1")

    def test_history_disabled_cannot_emit_answered(self):
        io = FakeIO(self.path, [{"answer": "text"}])
        io.user_input("question")
        io.chat_history_file = None
        with self.assertRaises(adapter.AdapterError):
            FakeCoder(io).run_one("question", True)
        self.assertEqual(len(self.records()), 1)

    def test_sidecar_fsync_before_return(self):
        with patch.object(adapter.os, "fsync", wraps=adapter.os.fsync) as sync:
            self.run_turn([{"answer": "final"}])
            self.assertEqual(sync.call_count, 2)


class VersionTests(unittest.TestCase):
    def test_unknown_version_refuses(self):
        with patch.object(adapter.importlib.metadata, "version", return_value="0.87.0"):
            with self.assertRaisesRegex(adapter.AdapterError, "exactly aider-chat==0.86.2"):
                adapter.validate_api(FakeCoder, FakeIO, fake_main, FakeCommands, FakeArchitect)

    def test_known_signatures_validate(self):
        with patch.object(adapter.importlib.metadata, "version", return_value="0.86.2"):
            adapter.validate_api(FakeCoder, FakeIO, fake_main, FakeCommands, FakeArchitect)

    def test_changed_signature_refuses(self):
        with patch.object(adapter.importlib.metadata, "version", return_value="0.86.2"), patch.object(FakeCoder, "run_one", lambda self, changed: None):
            with self.assertRaisesRegex(adapter.AdapterError, "signature"):
                adapter.validate_api(FakeCoder, FakeIO, fake_main, FakeCommands, FakeArchitect)


if __name__ == "__main__":
    unittest.main()

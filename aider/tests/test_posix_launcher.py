"""Offline launch resolution on macOS/Linux; no Aider or API calls."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


@unittest.skipIf(os.name == "nt", "POSIX launcher tests")
class PosixLauncherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.launcher = Path(__file__).parents[1] / "launch-adapter.sh"

    def python(self, name="python3"):
        path = self.root / name
        path.write_text('#!/bin/sh\nprintf "%s\\n" "$0" "$@"\n')
        path.chmod(0o755)
        return path

    def run_entry(self, content, target=None):
        entry = target or self.bin / "aider"
        entry.write_text(content)
        entry.chmod(0o755)
        if target:
            (self.bin / "aider").symlink_to(target)
        env = {**os.environ, "PATH": str(self.bin) + os.pathsep + os.environ["PATH"]}
        return subprocess.run(["bash", str(self.launcher), "--model", "test/model", "with space"],
                              env=env, text=True, capture_output=True, timeout=10)

    def assert_resolved(self, result, python):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), [str(python), str(self.launcher.parent / "domios_adapter.py"),
                                                     "--model", "test/model", "with space"])

    def test_absolute_shebang(self):
        python = self.python()
        self.assert_resolved(self.run_entry(f"#!{python}\nfrom aider.main import main\n"), python)

    def test_pipx_entry_symlink_preserves_venv_interpreter(self):
        python = self.python()
        self.assert_resolved(self.run_entry(f"#!{python}\nfrom aider.main import main\n", self.root / "real-aider"), python)

    def test_distlib_space_trampoline(self):
        python = self.python("Python With Spaces")
        script = f"#!/bin/sh\n'''exec' '{python}' \"$0\" \"$@\"\n' '''\nfrom aider.main import main\n"
        self.assert_resolved(self.run_entry(script), python)

    def test_uv_relative_trampoline(self):
        python = self.python("relative python")
        prefix = '"$(dirname -- "$(realpath -- "$0")")"/'
        script = f"#!/bin/sh\n'''exec' {prefix}'relative python' \"$0\" \"$@\"\n' '''\nfrom aider.main import main\n"
        self.assert_resolved(self.run_entry(script, self.root / "real-aider"), python)

    def test_unknown_shell_launcher_is_not_executed(self):
        marker = self.root / "should-not-exist"
        result = self.run_entry(f"#!/bin/sh\ntouch '{marker}'\nfrom aider.main import main\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("plainMode=true", result.stderr)
        self.assertFalse(marker.exists())

    def test_non_aider_entry_refused(self):
        python = self.python()
        result = self.run_entry(f"#!{python}\nfrom other import main\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not aider.main", result.stderr)


if __name__ == "__main__":
    unittest.main()

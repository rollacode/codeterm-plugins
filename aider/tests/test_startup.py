"""Offline startup-hook proofs with a fake adapter and real Python startup."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


class StartupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.startup = self.root / "plugin" / "startup"
        self.startup.mkdir(parents=True)
        shutil.copyfile(Path(__file__).parents[1] / "startup" / "sitecustomize.py", self.startup / "sitecustomize.py")
        self.previous = self.root / "previous"
        self.previous.mkdir()
        (self.previous / "sitecustomize.py").write_text(
            'import os\nos.environ["DOMIOS_CHAINED"] = "1"\n')
        (self.startup.parent / "domios_adapter.py").write_text('''
import json, os, sys
from pathlib import Path
def activate():
    if os.environ.get("DOMIOS_TEST_FAIL") == "1":
        raise RuntimeError("requires exactly aider-chat==0.86.2")
    Path(os.environ["DOMIOS_TEST_ACTIVATION"]).write_text(json.dumps({
        "argv":sys.argv, "pythonpath":os.environ.get("PYTHONPATH"),
        "sysPath":sys.path, "chained":os.environ.get("DOMIOS_CHAINED")}))
''')
        self.marker = self.root / "activation.json"
        self.main_marker = self.root / "main.json"
        self.env = {**os.environ, "PYTHONPATH": str(self.startup) + os.pathsep + str(self.previous),
                    "DOMIOS_AIDER_ADAPTER": "1", "DOMIOS_AIDER_SESSION_ID": "ct-launch-test",
                    "DOMIOS_TEST_ACTIVATION": str(self.marker), "DOMIOS_TEST_MAIN": str(self.main_marker)}
        # Inherited probe/test flags must not change this fixture.
        self.env.pop("DOMIOS_TEST_FAIL", None)

    def run_entry(self, name="aider", env=None):
        entry = self.root / name
        entry.write_text('''
import json, os, subprocess, sys
from pathlib import Path
child = subprocess.run([sys.executable, "-c", "import os; print(os.environ.get('PYTHONPATH', ''))"],
                       text=True, capture_output=True, timeout=10)
Path(os.environ["DOMIOS_TEST_MAIN"]).write_text(json.dumps({"child":child.stdout.strip(),
    "childStatus":child.returncode, "pythonpath":os.environ.get("PYTHONPATH"),
    "chained":os.environ.get("DOMIOS_CHAINED")}))
''')
        return subprocess.run([sys.executable, str(entry)], env=env or self.env, text=True, capture_output=True, timeout=20)

    def test_aider_entry_activates_in_its_interpreter(self):
        result = self.run_entry()
        self.assertEqual(result.returncode, 0, result.stderr)
        active = json.loads(self.marker.read_text())
        self.assertEqual(Path(active["argv"][0]).name, "aider")
        self.assertEqual(active["chained"], "1")

    def test_windows_aider_entry_name_activates(self):
        self.assertEqual(self.run_entry("aider.exe").returncode, 0)
        self.assertTrue(self.marker.exists())

    def test_hook_removed_from_pythonpath_sys_path_and_children(self):
        self.assertEqual(self.run_entry().returncode, 0)
        active = json.loads(self.marker.read_text())
        main = json.loads(self.main_marker.read_text())
        self.assertEqual(active["pythonpath"], str(self.previous))
        self.assertNotIn(str(self.startup), active["sysPath"])
        self.assertEqual(main["child"], str(self.previous))
        self.assertEqual(main["childStatus"], 0)

    def test_preexisting_sitecustomize_is_chained_without_adapter(self):
        env = {**self.env, "DOMIOS_AIDER_ADAPTER": "0"}
        self.assertEqual(self.run_entry(env=env).returncode, 0)
        self.assertEqual(json.loads(self.main_marker.read_text())["chained"], "1")
        self.assertFalse(self.marker.exists())

    def test_other_python_entry_does_not_activate(self):
        self.assertEqual(self.run_entry("other.py").returncode, 0)
        self.assertFalse(self.marker.exists())
        self.assertTrue(self.main_marker.exists())

    def test_missing_session_does_not_activate(self):
        env = dict(self.env)
        env.pop("DOMIOS_AIDER_SESSION_ID")
        self.assertEqual(self.run_entry(env=env).returncode, 0)
        self.assertFalse(self.marker.exists())

    def test_mismatch_refuses_before_aider_main_can_run(self):
        result = self.run_entry(env={**self.env, "DOMIOS_TEST_FAIL": "1"})
        self.assertEqual(result.returncode, 2)
        self.assertIn("requires exactly aider-chat==0.86.2", result.stderr)
        self.assertIn("plainMode=true", result.stderr)
        self.assertFalse(self.main_marker.exists())

    def test_chain_failure_cannot_silently_disable_active_adapter(self):
        (self.previous / "sitecustomize.py").write_text('raise RuntimeError("pre-existing startup failed")\n')
        result = self.run_entry()
        self.assertEqual(result.returncode, 2)
        self.assertIn("pre-existing startup failed", result.stderr)
        self.assertFalse(self.main_marker.exists())

    def test_missing_adapter_refuses(self):
        (self.startup.parent / "domios_adapter.py").unlink()
        result = self.run_entry()
        self.assertEqual(result.returncode, 2)
        self.assertIn("Domios Aider adapter refused launch", result.stderr)
        self.assertFalse(self.main_marker.exists())


if __name__ == "__main__":
    unittest.main()

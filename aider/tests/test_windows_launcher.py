"""Windows framing regressions, including a real ZIP after a PE stub."""
import io
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile


@unittest.skipUnless(os.name == "nt" and shutil.which("powershell"), "Windows PowerShell launcher tests")
class WindowsLauncherTests(unittest.TestCase):
    def resolve(self, frame, expected_success=True):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "aider.exe"
            path.write_bytes(frame)
            env = {**os.environ, "DOMIOS_LAUNCHER_TEST_ENTRY": str(path),
                   "DOMIOS_LAUNCHER_TEST_SCRIPT": str(Path(__file__).parents[1] / "launch-adapter.ps1")}
            result = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command",
                "$ErrorActionPreference='Stop'; . $env:DOMIOS_LAUNCHER_TEST_SCRIPT; Get-AiderInterpreter $env:DOMIOS_LAUNCHER_TEST_ENTRY"],
                env=env, text=True, capture_output=True, timeout=20)
            if expected_success:
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), sys.executable)
            else:
                self.assertNotEqual(result.returncode, 0)
            return result

    def pe_stub(self):
        stub = bytearray(512)
        stub[:2] = b"MZ"
        struct.pack_into("<I", stub, 60, 64)
        stub[64:68] = b"PE\0\0"
        return bytes(stub)

    def zipped_script(self, script):
        data = io.BytesIO()
        with zipfile.ZipFile(data, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("__main__.py", script)
        return data.getvalue()

    def test_uv_prepended_stub_relative_zip_offsets(self):
        self.resolve(self.pe_stub() + self.zipped_script(f"#!{sys.executable}\nfrom aider.main import main\n"))

    def test_distlib_outer_quoted_shebang_frame(self):
        self.resolve(self.pe_stub() + f'#!"{sys.executable}"\r\n'.encode() + self.zipped_script("from aider.main import main\n"))

    def test_uv_zip_followed_by_framed_interpreter_trailer(self):
        path = sys.executable.encode("utf-8")
        trailer = path + struct.pack("<I", len(path)) + b"UVSC"
        self.resolve(self.pe_stub() + self.zipped_script("from aider.main import main\n") + trailer)

    def test_uv_bad_trailer_length_refused(self):
        result = self.resolve(self.pe_stub() + self.zipped_script("from aider.main import main\n") + struct.pack("<I", 999999) + b"UVSC", False)
        self.assertIn("Invalid uv trailer length", result.stderr)

    def test_unknown_entry_point_refused(self):
        result = self.resolve(self.pe_stub() + self.zipped_script(f"#!{sys.executable}\nfrom other import main\n"), False)
        self.assertIn("not aider.main", result.stderr)

    def test_missing_framed_interpreter_refused(self):
        result = self.resolve(self.pe_stub() + self.zipped_script("from aider.main import main\n"), False)
        self.assertIn("Unknown Windows aider launcher", result.stderr)


if __name__ == "__main__":
    unittest.main()

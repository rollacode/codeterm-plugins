"""Aider-only, plugin-owned startup hook. No .pth or global environment writes."""
import importlib.machinery
import importlib.util
import os
from pathlib import Path
import sys


def same_directory(value, directory):
    try:
        return Path(value or os.curdir).resolve() == directory
    except (OSError, ValueError):
        return False


def remove_startup_directory(directory):
    # The parent shell is unchanged. Child Pythons must not inherit this hook.
    entries = os.environ.get("PYTHONPATH", "").split(os.pathsep)
    remaining = [value for value in entries if not same_directory(value, directory)]
    if remaining:
        os.environ["PYTHONPATH"] = os.pathsep.join(remaining)
    else:
        os.environ.pop("PYTHONPATH", None)
    sys.path[:] = [value for value in sys.path if not same_directory(value, directory)]


def chain_existing():
    spec = importlib.machinery.PathFinder.find_spec("sitecustomize", sys.path)
    if spec is None or spec.loader is None:
        return
    previous = importlib.util.module_from_spec(spec)
    current = sys.modules.get("sitecustomize")
    try:
        sys.modules["sitecustomize"] = previous
        spec.loader.exec_module(previous)
    finally:
        if current is not None:
            sys.modules["sitecustomize"] = current
        else:
            sys.modules.pop("sitecustomize", None)


def activate():
    directory = Path(__file__).resolve().parent
    remove_startup_directory(directory)
    entry = Path(sys.argv[0]).name.lower() if sys.argv else ""
    active = os.environ.get("DOMIOS_AIDER_ADAPTER") == "1" and bool(os.environ.get("DOMIOS_AIDER_SESSION_ID")) and entry in ("aider", "aider.exe")
    try:
        chain_existing()
        if not active:
            return
        # Load directly without putting the plugin root on sys.path.
        spec = importlib.util.spec_from_file_location("_domios_aider_adapter", directory.parent / "domios_adapter.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.activate()
    except BaseException as err:
        if not active:
            raise
        # site.py normally catches hook exceptions and continues; that would
        # silently bypass relay. Terminate explicitly after flushing diagnosis.
        sys.stderr.write("Domios Aider adapter refused launch: " + str(err) +
                         ". Install aider-chat==0.86.2 or explicitly set plainMode=true.\n")
        sys.stderr.flush()
        os._exit(2)


activate()

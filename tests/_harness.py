"""Import the plugin backend with stubbed DeckyLoader modules.

`main.py` imports `decky` and `settings`, which only exist inside the loader.
Stubbing both lets the backend run in an ordinary Python process, so the same
suite works on a build machine and on the Legion itself.

Set `LEGO_VIBE_PLUGIN_DIR` to test a deployed copy instead of the repo, e.g.
`/home/deck/homebrew/plugins/LeGo-Vibe-Control`.
"""
import json
import os
import sys
import tempfile
import types

PLUGIN_DIR = os.environ.get("LEGO_VIBE_PLUGIN_DIR") or os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))
)

_settings_dir = tempfile.mkdtemp(prefix="lego-vibe-tests-")


class StubLogger:
    """Records instead of printing, so tests can assert on what was logged."""

    def __init__(self):
        self.records = []

    def _log(self, level, message):
        self.records.append((level, str(message)))

    def info(self, message):
        self._log("info", message)

    def warning(self, message):
        self._log("warning", message)

    def error(self, message):
        self._log("error", message)

    def debug(self, message):
        self._log("debug", message)


_decky = types.ModuleType("decky")
_decky.logger = StubLogger()
_decky.DECKY_PLUGIN_SETTINGS_DIR = _settings_dir
sys.modules["decky"] = _decky


class SettingsManager:
    """Same surface as Decky's, backed by a throwaway JSON file."""

    def __init__(self, name, settings_directory):
        self.path = os.path.join(settings_directory, f"{name}.json")
        self.data = {}

    def read(self):
        try:
            with open(self.path) as handle:
                self.data = json.load(handle)
        except (OSError, ValueError):
            self.data = {}

    def getSetting(self, key, default=None):
        return self.data.get(key, default)

    def setSetting(self, key, value):
        self.data[key] = value

    def commit(self):
        with open(self.path, "w") as handle:
            json.dump(self.data, handle, indent=2)


_settings_mod = types.ModuleType("settings")
_settings_mod.SettingsManager = SettingsManager
sys.modules["settings"] = _settings_mod

# main.py and updater.py target Linux and import these at module scope. Stubbing
# them when absent lets the hardware-independent tests run on a Windows dev box
# too; nothing in test_logic.py touches either, and test_device.py skips itself.
for _unix_only in ("fcntl", "pwd"):
    try:
        __import__(_unix_only)
    except ImportError:
        _stub = types.ModuleType(_unix_only)
        if _unix_only == "pwd":
            # Referenced in an annotation that Python evaluates at def time.
            _stub.struct_passwd = object
        sys.modules[_unix_only] = _stub

sys.path.insert(0, PLUGIN_DIR)
import main  # noqa: E402
import updater  # noqa: E402


def seed(blob: dict) -> None:
    """Replace the settings file and drop every piece of cached state."""
    with open(main.settings.path, "w") as handle:
        json.dump(blob, handle, indent=2)
    main.settings.read()
    main._invalidate_cache()
    main._active_app_id = main.DEFAULT_APP


def has_device() -> bool:
    """True when the hid-lenovo-go sysfs endpoint is present."""
    try:
        return main._get_device_path() is not None
    except Exception:
        return False


# Two games with deliberately distinct values, so applying the wrong profile
# is unambiguous rather than a near miss.
GAME_WITH_OVERRIDE = "292030"     # level 3 (high), mode 4 (rpg)
GAME_WITHOUT_OVERRIDE = "2483190"

FIXTURE = {
    "schema_version": 2,
    "game_profiles": {
        "0": {
            "overwrite": False,
            "settings": {"level": 2, "mode": 1, "touchpadIntensity": 2,
                         "touchpadEnabled": True},
        },
        GAME_WITH_OVERRIDE: {
            "overwrite": True,
            "settings": {"level": 3, "mode": 4, "touchpadIntensity": 2,
                         "touchpadEnabled": True},
        },
        GAME_WITHOUT_OVERRIDE: {
            "overwrite": False,
            "settings": {"level": 0, "mode": 2, "touchpadIntensity": 1,
                         "touchpadEnabled": False},
        },
    },
}

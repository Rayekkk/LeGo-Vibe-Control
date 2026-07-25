import decky
import copy
import os
import re
import sys
import glob
import time
import asyncio
import struct
import fcntl
import threading
from settings import SettingsManager

# ── Optional pyudev - graceful fallback to glob if unavailable ─────────────────

# Ensure bundled libs (pyudev/) are importable regardless of how Decky
# sets up sys.path before loading this module.
PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
if PLUGIN_DIR not in sys.path:
    sys.path.insert(0, PLUGIN_DIR)

from updater import Updater  # noqa: E402 - needs the sys.path line above

try:
    import pyudev as _pyudev
    _udev_ctx = _pyudev.Context()
    _PYUDEV = True
except ImportError as _e:
    decky.logger.warning(f"[lego-vibe] pyudev import failed: {_e}")
    _pyudev = None
    _udev_ctx = None
    _PYUDEV = False
except Exception as _e:
    decky.logger.warning(f"[lego-vibe] pyudev init failed (libudev?): {_e}")
    _pyudev = None
    _udev_ctx = None
    _PYUDEV = False

# ── Constants ──────────────────────────────────────────────────────────────────

GITHUB_RELEASES_URL = "https://api.github.com/repos/Rayekkk/LeGo-Vibe-Control/releases/latest"

# Update checks, TLS trust store and downloads live in updater.py, which is
# kept identical in LeGoTDP so a fix lands in both plugins.
updater = Updater(
    releases_url=GITHUB_RELEASES_URL,
    user_agent="lego-vibe-plugin",
    log_prefix="[lego-vibe]",
    plugin_dir=PLUGIN_DIR,
    logger=decky.logger,
)

# Fallback value lists, used only when the driver does not expose the
# matching <attr>_index file. The driver on kernel 6.18 does expose them.
LEVEL_NAMES  = ["off", "low", "medium", "high"]
RUMBLE_MODES = ["fps", "racing", "standard", "spg", "rpg"]

DEFAULT_APP = "0"

# Profile field names. These match the shape the frontend has always
# persisted, so existing settings.json files migrate without translation.
PKEY_LEVEL  = "level"
PKEY_MODE   = "mode"
PKEY_TP_INT = "touchpadIntensity"
PKEY_TP_EN  = "touchpadEnabled"

DEFAULT_PROFILE = {
    PKEY_LEVEL:  2,     # medium
    PKEY_MODE:   0,     # fps
    PKEY_TP_INT: 2,     # medium
    PKEY_TP_EN:  True,
}

SETTINGS_KEY_GAME_PROFILES = "game_profiles"
SETTINGS_KEY_SCHEMA        = "schema_version"
CURRENT_SCHEMA             = 2

# Pre-schema-2 keys. Read once during migration, never written again.
_LEGACY_KEYS = {
    PKEY_LEVEL:  "intensity_level",
    PKEY_MODE:   "rumble_mode",
    PKEY_TP_INT: "touchpad_intensity",
    PKEY_TP_EN:  "touchpad_enabled",
}

settings = SettingsManager(
    name="settings",
    settings_directory=decky.DECKY_PLUGIN_SETTINGS_DIR,
)

# Profiles are read from the hotplug executor thread while RPC handlers write
# them from the event loop. Re-entrant because the write paths load first.
_settings_lock = threading.RLock()

# Sysfs attribute unique to the hid-lenovo-go driver
_SIGNATURE_ATTR = "rumble_intensity"

# Module-level device path (sysfs dir that owns rumble_intensity)
_device_path: str | None = None
_discovery_method: str | None = None
_monitor_task: asyncio.Task | None = None

# App id the frontend last reported as running. Drives profile resolution
# for hotplug and resume re-applies, which have no frontend round trip.
_active_app_id: str = DEFAULT_APP

# Serialises sysfs writes between RPC calls, hotplug and resume.
_apply_lock = threading.Lock()

# Guards against stacking effects, e.g. the test button being tapped twice.
# Two concurrent FF effects on one device combine into something that
# resembles neither pattern.
_ff_busy = False

# Force-feedback ioctl numbers (Linux x86-64, sizeof(ff_effect) == 48)
_EVIOCGBIT_FF = 0x80204535
_EVIOCSFF     = 0x40304580
_EVIOCRMFF    = 0x40044581
_EV_FF        = 0x15
_FF_RUMBLE    = 0x50


# ── Device discovery ───────────────────────────────────────────────────────────

def _discover() -> tuple[str | None, str | None]:
    """
    Return (sysfs_dir, method) where sysfs_dir contains rumble_intensity.
    Tries pyudev enumeration first; falls back to a driver-agnostic
    glob over /sys/bus/hid/drivers/*/ (no driver name hardcoded).
    """
    if _PYUDEV:
        found_any = False
        for dev in _udev_ctx.list_devices(subsystem='hid'):
            found_any = True
            candidate = os.path.join(dev.sys_path, _SIGNATURE_ATTR)
            if os.path.exists(candidate):
                decky.logger.info(f"[lego-vibe] found via pyudev: {dev.sys_path}")
                return dev.sys_path, "pyudev"
        if not found_any:
            decky.logger.warning("[lego-vibe] pyudev returned no HID devices at all")
        else:
            decky.logger.warning("[lego-vibe] pyudev: no HID device has rumble_intensity")

    # Glob fallback - driver-name-agnostic, searches all HID drivers.
    # Path structure: /sys/bus/hid/drivers/<driver>/<device_id>/rumble_intensity
    patterns = [
        (f"/sys/bus/hid/drivers/*/*/{_SIGNATURE_ATTR}", "glob-hid"),
        (f"/sys/module/*/drivers/hid:*/{_SIGNATURE_ATTR}", "glob-module"),
    ]
    for pattern, method in patterns:
        for match in glob.glob(pattern):
            path = os.path.dirname(match)
            decky.logger.info(f"[lego-vibe] found via {method} ({pattern}): {path}")
            return path, method

    decky.logger.warning("[lego-vibe] device not found (pyudev and glob both failed)")
    return None, None


def _get_device_path() -> str | None:
    global _device_path, _discovery_method
    if _device_path is not None:
        if os.path.exists(os.path.join(_device_path, _SIGNATURE_ATTR)):
            return _device_path
        _forget_device()
    _device_path, _discovery_method = _discover()
    return _device_path


def _forget_device() -> None:
    """Drop the cached device path and everything derived from it."""
    global _device_path, _discovery_method
    if _device_path is not None:
        _invalidate_cache(_device_path)
        _capabilities_cache.pop(_device_path, None)
    _device_path = None
    _discovery_method = None
    _ff_device_cache["node"] = None


def _device_ids(sys_path: str) -> tuple[str, str] | None:
    """
    Extract (vendor, product) as lowercase hex from a HID sysfs dir name
    like '0003:17EF:61EB.0013'.
    """
    m = re.match(r'^[0-9A-Fa-f]+:([0-9A-Fa-f]{4}):([0-9A-Fa-f]{4})',
                 os.path.basename(sys_path))
    return (m.group(1).lower(), m.group(2).lower()) if m else None


# ── Driver capabilities (valid enum values, read from <attr>_index) ────────────

_capabilities_cache: dict[str, dict[str, list[str]]] = {}


def _read_enum(sys_path: str, rel_path: str, fallback: list[str]) -> list[str]:
    """
    The driver publishes the legal values of every enum attribute in a
    sibling '<attr>_index' file, space separated. Prefer that over a
    hardcoded list so new driver values do not need a plugin release.
    """
    try:
        with open(os.path.join(sys_path, rel_path + '_index')) as f:
            values = f.read().split()
        if values:
            return values
    except OSError:
        pass
    return list(fallback)


def _capabilities(sys_path: str) -> dict[str, list[str]]:
    caps = _capabilities_cache.get(sys_path)
    if caps is None:
        caps = {
            "intensity":    _read_enum(sys_path, 'rumble_intensity', LEVEL_NAMES),
            "mode":         _read_enum(sys_path, 'left_handle/rumble_mode', RUMBLE_MODES),
            "tp_intensity": _read_enum(sys_path, 'touchpad/vibration_intensity', LEVEL_NAMES),
        }
        _capabilities_cache[sys_path] = caps
        decky.logger.info(f"[lego-vibe] capabilities: {caps}")
    return caps


def _enum_at(values: list[str], index: int) -> str:
    return values[max(0, min(len(values) - 1, int(index)))]


# ── Sysfs writes ───────────────────────────────────────────────────────────────

# In-memory cache of the last value we successfully wrote to each attribute.
# The hid-lenovo-go driver does not reliably reflect written values on
# subsequent reads - rumble_intensity returns the value from *before* the
# last write - so we track state ourselves rather than reading back.
# Anything that may have reset the hardware (hotplug, resume from suspend)
# must invalidate this, otherwise writes get skipped as no-ops.
_attr_cache: dict[tuple[str, str], str] = {}


def _invalidate_cache(sys_path: str | None = None) -> None:
    if sys_path is None:
        _attr_cache.clear()
    else:
        for key in [k for k in _attr_cache if k[0] == sys_path]:
            del _attr_cache[key]


def _write_attr(sys_path: str, rel_path: str, value: str, force: bool = False) -> bool:
    key = (sys_path, rel_path)
    if not force and _attr_cache.get(key) == value:
        return True
    path = os.path.join(sys_path, rel_path)
    try:
        with open(path, 'w') as f:
            f.write(value + '\n')
        _attr_cache[key] = value
        decky.logger.info(f"[lego-vibe] {rel_path} = '{value}'")
        return True
    except OSError as exc:
        _attr_cache.pop(key, None)
        decky.logger.error(f"[lego-vibe] write {path}: {exc}")
        return False


def _apply_settings(values: dict, sys_path: str | None = None,
                    force: bool = False) -> bool:
    """Write a full profile to the hardware. Every attribute is attempted."""
    with _apply_lock:
        p = sys_path or _get_device_path()
        if p is None:
            return False
        caps = _capabilities(p)
        mode = _enum_at(caps["mode"], values[PKEY_MODE])
        results = [
            _write_attr(p, 'rumble_intensity',
                        _enum_at(caps["intensity"], values[PKEY_LEVEL]), force),
            _write_attr(p, 'left_handle/rumble_mode',  mode, force),
            _write_attr(p, 'right_handle/rumble_mode', mode, force),
            _write_attr(p, 'touchpad/vibration_intensity',
                        _enum_at(caps["tp_intensity"], values[PKEY_TP_INT]), force),
            _write_attr(p, 'touchpad/vibration_enabled',
                        "true" if values[PKEY_TP_EN] else "false", force),
        ]
        return all(results)


# ── Profile store - the single source of truth for settings ────────────────────

def _coerce_int(value, default: int, low: int, high: int | None) -> int:
    """Clamp to a sane range, falling back to the default on junk. A
    hand-edited or truncated settings.json must never crash an apply."""
    try:
        result = max(low, int(value))
    except (TypeError, ValueError):
        return default
    return result if high is None else min(high, result)


def _coerce_profile(raw: dict | None) -> dict:
    """Fill in missing fields and sanitise types."""
    raw = raw if isinstance(raw, dict) else {}
    return {
        PKEY_LEVEL:  _coerce_int(raw.get(PKEY_LEVEL), DEFAULT_PROFILE[PKEY_LEVEL], 0, 3),
        # No upper bound: the mode count comes from the driver, and
        # _enum_at() clamps against the list it actually reports.
        PKEY_MODE:   _coerce_int(raw.get(PKEY_MODE), DEFAULT_PROFILE[PKEY_MODE], 0, None),
        PKEY_TP_INT: _coerce_int(raw.get(PKEY_TP_INT), DEFAULT_PROFILE[PKEY_TP_INT], 0, 3),
        PKEY_TP_EN:  bool(raw.get(PKEY_TP_EN, DEFAULT_PROFILE[PKEY_TP_EN])),
    }


def _load_profiles() -> dict:
    """A private copy of the profile store. Callers coerce and mutate what they
    get back, and getSetting hands out a live reference into the manager's own
    dict - so without the copy those edits would land in the store uncommitted,
    and a later read() would silently drop them again."""
    with _settings_lock:
        settings.read()
        profiles = settings.getSetting(SETTINGS_KEY_GAME_PROFILES, {}) or {}
        profiles = copy.deepcopy(profiles) if isinstance(profiles, dict) else {}
    if DEFAULT_APP not in profiles:
        profiles[DEFAULT_APP] = {"overwrite": False, "settings": dict(DEFAULT_PROFILE)}
    return profiles


def _save_profiles(profiles: dict) -> None:
    with _settings_lock:
        settings.setSetting(SETTINGS_KEY_GAME_PROFILES, profiles)
        settings.commit()


def _resolve_app_id(profiles: dict, app_id: str | None = None) -> str:
    """A game's profile only wins while it is both running and flagged."""
    app_id = _active_app_id if app_id is None else app_id
    if app_id != DEFAULT_APP and profiles.get(app_id, {}).get("overwrite"):
        return app_id
    return DEFAULT_APP


def _active_values(profiles: dict | None = None) -> dict:
    profiles = _load_profiles() if profiles is None else profiles
    entry = profiles.get(_resolve_app_id(profiles), {})
    return _coerce_profile(entry.get("settings"))


def _migrate() -> None:
    """Fold the old flat settings keys into profile '0' exactly once."""
    with _settings_lock:
        settings.read()
        if int(settings.getSetting(SETTINGS_KEY_SCHEMA, 1)) >= CURRENT_SCHEMA:
            return
        profiles = settings.getSetting(SETTINGS_KEY_GAME_PROFILES, {}) or {}
        if not isinstance(profiles, dict):
            profiles = {}
        if DEFAULT_APP not in profiles:
            legacy = {
                field: settings.getSetting(old_key, DEFAULT_PROFILE[field])
                for field, old_key in _LEGACY_KEYS.items()
            }
            profiles[DEFAULT_APP] = {"overwrite": False,
                                     "settings": _coerce_profile(legacy)}
            decky.logger.info(
                f"[lego-vibe] migrated legacy settings into the global profile: {legacy}")
        settings.setSetting(SETTINGS_KEY_GAME_PROFILES, profiles)
        settings.setSetting(SETTINGS_KEY_SCHEMA, CURRENT_SCHEMA)
        settings.commit()


def _update_active(field: str, value) -> dict:
    """Write one field into whichever profile is currently in effect."""
    profiles = _load_profiles()
    app_id = _resolve_app_id(profiles)
    entry = profiles.setdefault(app_id, {"overwrite": app_id != DEFAULT_APP,
                                         "settings": dict(DEFAULT_PROFILE)})
    entry["settings"] = _coerce_profile(entry.get("settings"))
    entry["settings"][field] = value
    _save_profiles(profiles)
    return entry["settings"]


# ── Force feedback ─────────────────────────────────────────────────────────────

_ff_device_cache: dict[str, str | None] = {"node": None}


def _event_nodes() -> list[str]:
    # Numeric sort: a lexicographic sort puts event16 before event2, which is
    # how the Steam virtual pad used to win over the real controller.
    nodes = glob.glob('/dev/input/event*')
    return sorted(nodes, key=lambda n: int(re.sub(r'\D', '', os.path.basename(n)) or 0))


def _node_ids(node: str) -> tuple[str, str] | None:
    base = os.path.basename(node)
    try:
        with open(f'/sys/class/input/{base}/device/id/vendor') as f:
            vendor = f.read().strip().lower()
        with open(f'/sys/class/input/{base}/device/id/product') as f:
            product = f.read().strip().lower()
        return vendor, product
    except OSError:
        return None


def _has_rumble(node: str) -> bool:
    try:
        with open(node, 'rb') as fh:
            bits = bytearray(32)
            fcntl.ioctl(fh.fileno(), _EVIOCGBIT_FF, bits)
            return bool(bits[_FF_RUMBLE // 8] & (1 << (_FF_RUMBLE % 8)))
    except OSError as exc:
        decky.logger.debug(f"[lego-vibe] FF probe {node}: {exc}")
        return False


def _find_ff_device() -> str | None:
    """
    Return the evdev node of the Legion controller, matched by the same
    vendor:product as the discovered HID device. Falls back to any
    rumble-capable node so the test button still does something on
    hardware we failed to identify.
    """
    cached = _ff_device_cache.get("node")
    if cached and os.path.exists(cached):
        return cached

    sys_path = _get_device_path()
    want = _device_ids(sys_path) if sys_path else None

    fallback = None
    for node in _event_nodes():
        if not _has_rumble(node):
            continue
        if want and _node_ids(node) == want:
            decky.logger.info(f"[lego-vibe] FF device: {node} (matched {want[0]}:{want[1]})")
            _ff_device_cache["node"] = node
            return node
        if fallback is None:
            fallback = node

    if fallback:
        decky.logger.warning(f"[lego-vibe] FF device: {fallback} (no VID:PID match, using first rumble-capable node)")
        _ff_device_cache["node"] = fallback
    return fallback


# ── Hotplug monitor (only when pyudev is available) ────────────────────────────

# 'add' fires before the driver has probed, so rumble_intensity usually does
# not exist yet. 'bind' is the event that means the driver is attached.
_HOTPLUG_ACTIONS = ("add", "bind", "change")


async def _monitor_hotplug() -> None:
    if not _PYUDEV:
        decky.logger.info("[lego-vibe] pyudev unavailable, hotplug monitor disabled")
        return
    global _device_path, _discovery_method

    monitor = _pyudev.Monitor.from_netlink(_udev_ctx)
    monitor.filter_by(subsystem='hid')
    monitor.start()

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    # Read the netlink socket via the event loop instead of parking a thread
    # pool worker in a blocking poll() for the lifetime of the plugin.
    # start() put the fd in non-blocking mode, so poll(0) drains and returns.
    def _on_readable() -> None:
        for device in iter(lambda: monitor.poll(0), None):
            queue.put_nowait((device.action, device.sys_path))

    loop.add_reader(monitor.fileno(), _on_readable)
    try:
        while True:
            action, sys_path = await queue.get()
            if action in _HOTPLUG_ACTIONS:
                await _handle_device_added(sys_path, action)
            elif action in ('remove', 'unbind') and sys_path == _device_path:
                # Events can arrive out of order: an unbind/rebind cycle
                # delivers the removal after the device is already back. Trust
                # sysfs over the event ordering, or we would drop a device
                # that is present and stop applying settings to it.
                if os.path.exists(os.path.join(sys_path, _SIGNATURE_ATTR)):
                    decky.logger.info(
                        f"[lego-vibe] ignoring stale '{action}' - device is still present"
                    )
                else:
                    decky.logger.info("[lego-vibe] device disconnected")
                    _forget_device()
    except asyncio.CancelledError:
        pass
    finally:
        try:
            loop.remove_reader(monitor.fileno())
        except Exception:
            pass


async def _handle_device_added(sys_path: str, action: str) -> None:
    global _device_path, _discovery_method
    attribute = os.path.join(sys_path, _SIGNATURE_ATTR)
    if not os.path.exists(attribute):
        # Only 'add' and 'bind' can race the driver's probe. A 'change' on a
        # device that has no rumble_intensity is simply not our device, and
        # waiting on it would stall every other queued event for a second -
        # a single `udevadm trigger` fans out to every HID device on the bus.
        if action not in ('add', 'bind'):
            return
        for _ in range(10):
            await asyncio.sleep(0.1)
            if os.path.exists(attribute):
                break
        else:
            return

    # A 'change' on the device we already own is not skipped: it still means
    # the firmware may have reset, so we fall through and force a re-apply.
    decky.logger.info(f"[lego-vibe] device available via '{action}': {sys_path}")
    _device_path = sys_path
    _discovery_method = f"udev-{action}"
    _ff_device_cache["node"] = None

    def _apply() -> bool:
        _invalidate_cache(sys_path)
        _capabilities_cache.pop(sys_path, None)
        return _apply_settings(_active_values(), sys_path=sys_path, force=True)

    ok = await asyncio.get_running_loop().run_in_executor(None, _apply)
    decky.logger.info(f"[lego-vibe] re-applied profile after '{action}': success={ok}")


# ── Plugin class ───────────────────────────────────────────────────────────────

class Plugin:

    # Surfaced through is_ready() so a failed start shows up in the panel
    # instead of leaving the user with sliders that silently do nothing.
    _setup_error: str | None = None

    async def _main(self):
        global _monitor_task
        decky.logger.info(
            f"[lego-vibe] startup  v{updater.plugin_version()}  pyudev={_PYUDEV}")
        try:
            _migrate()
            values = _active_values()
            decky.logger.info(f"[lego-vibe] applying global profile: {values}")
            _apply_settings(values, force=True)
            # Resolve the trust store now so the log shows up front whether
            # update checks will be able to verify certificates.
            updater.ssl_context()
            _monitor_task = asyncio.create_task(_monitor_hotplug())
            Plugin._setup_error = None
        except Exception as exc:
            Plugin._setup_error = str(exc)
            decky.logger.error(f"[lego-vibe] setup failed: {exc}")

    async def _unload(self):
        global _monitor_task
        if _monitor_task:
            _monitor_task.cancel()
            try:
                await _monitor_task
            except asyncio.CancelledError:
                pass
            _monitor_task = None
        decky.logger.info("[lego-vibe] unloaded")

    # Decky calls these around system sleep on loader versions that support
    # them. The frontend also calls reapply() on resume, and both paths are
    # idempotent, so it does not matter which one fires.
    async def _suspend(self):
        decky.logger.info("[lego-vibe] suspending")

    async def _resume(self):
        decky.logger.info("[lego-vibe] resumed, re-applying")
        await self.reapply()

    # ---- RPC surface ------------------------------------------------ #

    async def is_ready(self) -> dict:
        return {"ready": Plugin._setup_error is None, "error": Plugin._setup_error or ""}

    async def get_version(self) -> dict:
        return {"version": updater.plugin_version()}

    async def get_capabilities(self) -> dict:
        p = _get_device_path()
        caps = _capabilities(p) if p else {
            "intensity": LEVEL_NAMES, "mode": RUMBLE_MODES, "tp_intensity": LEVEL_NAMES,
        }
        return caps

    async def get_settings(self) -> dict:
        """Resolved settings for whichever profile is currently in effect."""
        profiles = _load_profiles()
        app_id = _resolve_app_id(profiles)
        return {
            "settings":   _active_values(profiles),
            "app_id":     _active_app_id,
            "profile_id": app_id,
            "overwrite":  app_id != DEFAULT_APP,
        }

    async def set_active_app(self, app_id: str) -> dict:
        """
        Frontend reports the running game. Applying here rather than in the
        frontend keeps hotplug and resume able to pick the right profile.
        """
        global _active_app_id
        app_id = str(app_id or DEFAULT_APP)
        decky.logger.info(f"[lego-vibe] frontend reports running app '{app_id}'")
        if app_id == _active_app_id:
            return {"success": True, "changed": False, **(await self.get_settings())}
        _active_app_id = app_id
        values = _active_values()
        decky.logger.info(f"[lego-vibe] active app -> {app_id}, applying {values}")
        ok = _apply_settings(values)
        return {"success": ok, "changed": True, **(await self.get_settings())}

    async def _set_field(self, field: str, value) -> dict:
        values = _update_active(field, value)
        ok = _apply_settings(values)
        return {"success": ok, "settings": values}

    async def set_intensity(self, level: int) -> dict:
        return await self._set_field(PKEY_LEVEL, max(0, min(3, int(level))))

    async def set_rumble_mode(self, mode_idx: int) -> dict:
        """
        Set the vibration pattern. The controller firmware demonstrates the
        new mode by itself, so the plugin deliberately does not play one -
        doing so put a second, unsynchronised rumble on top of the firmware's
        and made the same mode feel different every time.
        """
        return await self._set_field(PKEY_MODE, max(0, int(mode_idx)))

    async def set_touchpad_intensity(self, level: int) -> dict:
        return await self._set_field(PKEY_TP_INT, max(0, min(3, int(level))))

    async def set_touchpad_enabled(self, enabled: bool) -> dict:
        return await self._set_field(PKEY_TP_EN, bool(enabled))

    async def reset_to_default(self) -> dict:
        profiles = _load_profiles()
        app_id = _resolve_app_id(profiles)
        entry = profiles.setdefault(app_id, {"overwrite": app_id != DEFAULT_APP,
                                             "settings": {}})
        entry["settings"] = dict(DEFAULT_PROFILE)
        _save_profiles(profiles)
        ok = _apply_settings(entry["settings"], force=True)
        return {"success": ok, "settings": entry["settings"]}

    async def reapply(self) -> dict:
        """
        Force every attribute back onto the hardware. Used after resume from
        suspend, where the controller comes back at its firmware defaults but
        the write cache still believes our values are in place.
        """
        _forget_device()
        values = _active_values()
        ok = _apply_settings(values, force=True)
        decky.logger.info(f"[lego-vibe] reapply: success={ok} values={values}")
        return {"success": ok, "settings": values}

    # ---- Per-game profiles ------------------------------------------ #

    async def get_game_profiles(self) -> dict:
        return _load_profiles()

    async def set_profile_overwrite(self, app_id: str, enabled: bool,
                                    name: str = "") -> dict:
        """Turn a per-game profile on or off and apply the result."""
        app_id = str(app_id or DEFAULT_APP)
        if app_id == DEFAULT_APP:
            return {"success": False, "error": "The global profile cannot be overridden"}
        profiles = _load_profiles()
        entry = profiles.get(app_id)
        if entry is None:
            # Seed a new per-game profile from whatever is active right now.
            entry = {"overwrite": bool(enabled), "settings": _active_values(profiles)}
            profiles[app_id] = entry
        else:
            entry["overwrite"] = bool(enabled)
            entry["settings"] = _coerce_profile(entry.get("settings"))
        # Remember the title so the profile list is readable when the game
        # is not running and Steam cannot resolve the id for us.
        if name:
            entry["name"] = str(name)
        _save_profiles(profiles)
        values = _active_values(profiles)
        ok = _apply_settings(values)
        decky.logger.info(f"[lego-vibe] per-game profile {app_id} overwrite={enabled}, applied {values}")
        return {"success": ok, "settings": values, "overwrite": bool(enabled)}

    async def delete_game_profile(self, app_id: str) -> dict:
        app_id = str(app_id or DEFAULT_APP)
        if app_id == DEFAULT_APP:
            return {"success": False, "error": "The global profile cannot be deleted"}
        profiles = _load_profiles()
        if profiles.pop(app_id, None) is None:
            return {"success": False, "error": "No such profile"}
        _save_profiles(profiles)
        values = _active_values(profiles)
        ok = _apply_settings(values)
        decky.logger.info(f"[lego-vibe] deleted profile {app_id}")
        return {"success": ok, "settings": values}

    async def set_game_profiles(self, profiles: dict) -> dict:
        """Bulk replace. Retained for compatibility with older frontends."""
        if not isinstance(profiles, dict):
            return {"success": False, "error": "profiles must be an object"}
        _save_profiles(profiles)
        return {"success": True}

    # ---- Driver status ---------------------------------------------- #

    async def get_driver_status(self) -> dict:
        p = _get_device_path()
        ids = _device_ids(p) if p else None
        decky.logger.info(
            f"[lego-vibe] get_driver_status -> path={p!r} pyudev={_PYUDEV} method={_discovery_method!r}"
        )
        return {
            "found":  p is not None,
            "paths":  [p] if p else [],
            "method": _discovery_method or "",
            "ids":    f"{ids[0]}:{ids[1]}" if ids else "",
        }

    # ---- Updates ----------------------------------------------------- #

    async def check_for_updates(self) -> dict:
        return await asyncio.get_running_loop().run_in_executor(None, updater.check)

    async def perform_update(self, download_url: str, asset_name: str) -> dict:
        return await asyncio.get_running_loop().run_in_executor(
            None, updater.download, download_url, asset_name)

    # ---- Test ------------------------------------------------------- #

    async def test_vibration(self, duration_ms: int = 500) -> dict:
        global _ff_busy
        values = _active_values()
        level = values[PKEY_LEVEL]
        if level <= 0:
            return {"success": False, "error": "Intensity is Off - raise it to feel the test"}
        if _ff_busy:
            # Dropping the request beats queueing a pile of buzzes behind a
            # slider the user is still dragging.
            return {"success": False, "error": "A vibration is already playing"}

        intensity_pct = [0, 33, 66, 100][max(0, min(3, level))]
        duration = max(100, min(2000, int(duration_ms)))
        magnitude = int(0xFFFF * intensity_pct / 100)

        ff_path = _find_ff_device()
        if ff_path is None:
            decky.logger.warning("[lego-vibe] test_vibration: no FF device found")
            return {"success": False, "error": "No rumble-capable input device found"}

        _ff_busy = True
        try:
            fd = os.open(ff_path, os.O_RDWR)
            try:
                effect_buf = bytearray(struct.pack(
                    '<HhHHHHHxxHH28x',
                    _FF_RUMBLE, -1, 0,
                    0, 0,
                    duration, 0,
                    magnitude, magnitude,
                ))
                fcntl.ioctl(fd, _EVIOCSFF, effect_buf)
                effect_id = struct.unpack_from('<h', effect_buf, 2)[0]
                if effect_id < 0:
                    return {"success": False, "error": f"Driver rejected FF effect (id={effect_id})"}

                def _input_event(ev_type: int, code: int, value: int) -> bytes:
                    t = time.time()
                    return struct.pack('<qqHHi', int(t), int((t % 1) * 1e6) % 1_000_000,
                                       ev_type, code, value)

                os.write(fd, _input_event(_EV_FF, effect_id, 1))
                await asyncio.sleep(duration / 1000.0)
                os.write(fd, _input_event(_EV_FF, effect_id, 0))
                # EVIOCRMFF is declared _IOW(..., int) but the kernel reads the
                # effect id straight out of the argument value
                # (input_ff_erase(dev, (int)(unsigned long) p, file)). Passing a
                # packed buffer makes it erase whatever id the pointer happens
                # to look like, which always failed with EINVAL and leaked the
                # effect slot. Pass the id by value.
                fcntl.ioctl(fd, _EVIOCRMFF, effect_id)

                decky.logger.info(
                    f"[lego-vibe] test_vibration: level={level} ({intensity_pct}%) "
                    f"mag={magnitude:#06x} duration={duration}ms via {ff_path}"
                )
                return {"success": True}
            finally:
                os.close(fd)
        except Exception as exc:
            _ff_device_cache["node"] = None
            decky.logger.error(f"[lego-vibe] test_vibration failed: {exc}")
            return {"success": False, "error": str(exc)}
        finally:
            _ff_busy = False

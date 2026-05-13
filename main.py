import decky
import os
import sys
import time
import asyncio
import struct
import fcntl
from settings import SettingsManager

# ------------------------------------------------------------------ #
# Optional pyudev — graceful fallback to glob if unavailable
# ------------------------------------------------------------------ #

# Ensure bundled libs (pyudev/) are importable regardless of how Decky
# sets up sys.path before loading this module.
_plugin_dir = os.path.dirname(os.path.abspath(__file__))
if _plugin_dir not in sys.path:
    sys.path.insert(0, _plugin_dir)

try:
    import pyudev as _pyudev
    _udev_ctx = _pyudev.Context()
    _PYUDEV = True
except ImportError as _e:
    decky.logger.warning(f"[lgo2-vibe] pyudev import failed: {_e}")
    _pyudev = None
    _udev_ctx = None
    _PYUDEV = False
except Exception as _e:
    decky.logger.warning(f"[lgo2-vibe] pyudev init failed (libudev?): {_e}")
    _pyudev = None
    _udev_ctx = None
    _PYUDEV = False

# ------------------------------------------------------------------ #
# Constants
# ------------------------------------------------------------------ #

LEVEL_NAMES    = ["off", "low", "medium", "high"]
DEFAULT_LEVEL  = 2  # medium

# ABI doc lists "standarg" — likely a typo for "standard" in the kernel docs.
RUMBLE_MODES   = ["fps", "racing", "standard", "spg", "rpg"]
DEFAULT_MODE   = 0  # fps

SETTINGS_KEY_LEVEL    = "intensity_level"
SETTINGS_KEY_LEFT_EN  = "left_enabled"
SETTINGS_KEY_RIGHT_EN = "right_enabled"
SETTINGS_KEY_MODE     = "rumble_mode"

settings = SettingsManager(
    name="settings",
    settings_directory=decky.DECKY_PLUGIN_SETTINGS_DIR,
)

# Sysfs attribute unique to the hid-lenovo-go driver
_SIGNATURE_ATTR = "rumble_intensity"

# Module-level device path (sysfs dir that owns rumble_intensity)
_device_path: str | None = None
_discovery_method: str | None = None
_monitor_task: asyncio.Task | None = None

# Force-feedback ioctl numbers (Linux x86-64, sizeof(ff_effect) == 48)
_EVIOCGBIT_FF = 0x80204535
_EVIOCSFF     = 0x40304580
_EVIOCRMFF    = 0x40044581
_EV_FF        = 0x15
_FF_RUMBLE    = 0x50


# ------------------------------------------------------------------ #
# Device discovery
# ------------------------------------------------------------------ #

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
                decky.logger.info(f"[lgo2-vibe] found via pyudev: {dev.sys_path}")
                return dev.sys_path, "pyudev"
        if not found_any:
            decky.logger.warning("[lgo2-vibe] pyudev returned no HID devices at all")
        else:
            decky.logger.warning("[lgo2-vibe] pyudev: no HID device has rumble_intensity")

    # Glob fallback — driver-name-agnostic, searches all HID drivers.
    # Path structure: /sys/bus/hid/drivers/<driver>/<device_id>/rumble_intensity
    #   → needs two wildcards after drivers/
    import glob as _glob
    patterns = [
        (f"/sys/bus/hid/drivers/*/*/{_SIGNATURE_ATTR}", "glob-hid"),
        (f"/sys/module/*/drivers/hid:*/{_SIGNATURE_ATTR}", "glob-module"),
    ]
    for pattern, method in patterns:
        for match in _glob.glob(pattern):
            path = os.path.dirname(match)
            decky.logger.info(f"[lgo2-vibe] found via {method} ({pattern}): {path}")
            return path, method

    decky.logger.warning("[lgo2-vibe] device not found (pyudev and glob both failed)")
    return None, None


def _get_device_path() -> str | None:
    global _device_path, _discovery_method
    if _device_path is not None:
        if os.path.exists(os.path.join(_device_path, _SIGNATURE_ATTR)):
            return _device_path
        _device_path = None
        _discovery_method = None
    _device_path, _discovery_method = _discover()
    return _device_path


# ------------------------------------------------------------------ #
# Sysfs helpers
# ------------------------------------------------------------------ #

def _int_to_level(value: int) -> str:
    return LEVEL_NAMES[max(0, min(3, int(value)))]


def _write_attr(sys_path: str, rel_path: str, value: str) -> bool:
    path = os.path.join(sys_path, rel_path)
    try:
        with open(path, 'w') as f:
            f.write(value + '\n')
        decky.logger.info(f"[lgo2-vibe] {rel_path} = '{value}'")
        return True
    except OSError as exc:
        decky.logger.error(f"[lgo2-vibe] write {path}: {exc}")
        return False


def _write_rumble_intensity(level_int: int) -> bool:
    p = _get_device_path()
    if p is None:
        return False
    return _write_attr(p, 'rumble_intensity', _int_to_level(level_int))


def _write_rumble_mode(mode_idx: int) -> bool:
    p = _get_device_path()
    if p is None:
        return False
    mode = RUMBLE_MODES[max(0, min(len(RUMBLE_MODES) - 1, int(mode_idx)))]
    ok_l = _write_attr(p, 'left_handle/rumble_mode',  mode)
    ok_r = _write_attr(p, 'right_handle/rumble_mode', mode)
    return ok_l and ok_r


def _write_handle_notification(handle: str, enabled: bool) -> bool:
    p = _get_device_path()
    if p is None:
        return False
    return _write_attr(p, f"{handle}_handle/rumble_notification", "true" if enabled else "false")


def _find_ff_device() -> str | None:
    """Return first evdev node with FF_RUMBLE capability."""
    if _PYUDEV:
        nodes = sorted(
            dev.device_node
            for dev in _udev_ctx.list_devices(subsystem='input')
            if dev.device_node and dev.device_node.startswith('/dev/input/event')
        )
    else:
        import glob as _glob
        nodes = sorted(_glob.glob('/dev/input/event*'))

    for node in nodes:
        try:
            with open(node, 'rb') as fh:
                bits = bytearray(32)
                fcntl.ioctl(fh.fileno(), _EVIOCGBIT_FF, bits)
                if bits[_FF_RUMBLE // 8] & (1 << (_FF_RUMBLE % 8)):
                    decky.logger.info(f"[lgo2-vibe] FF device: {node}")
                    return node
        except Exception:
            pass
    return None


# ------------------------------------------------------------------ #
# Hotplug monitor (only when pyudev is available)
# ------------------------------------------------------------------ #

async def _monitor_hotplug() -> None:
    if not _PYUDEV:
        decky.logger.info("[lgo2-vibe] pyudev unavailable, hotplug monitor disabled")
        return
    global _device_path, _discovery_method
    monitor = _pyudev.Monitor.from_netlink(_udev_ctx)
    monitor.filter_by(subsystem='hid')
    monitor.start()
    loop = asyncio.get_event_loop()
    try:
        while True:
            event = await loop.run_in_executor(None, monitor.poll, 1.0)
            if event is None:
                continue
            if event.action == 'add':
                if os.path.exists(os.path.join(event.sys_path, _SIGNATURE_ATTR)):
                    _device_path = event.sys_path
                    _discovery_method = "udev-hotplug"
                    decky.logger.info(f"[lgo2-vibe] device connected: {event.sys_path}")
                    settings.read()
                    _write_rumble_intensity(settings.getSetting(SETTINGS_KEY_LEVEL,    DEFAULT_LEVEL))
                    _write_rumble_mode(settings.getSetting(SETTINGS_KEY_MODE,          DEFAULT_MODE))
                    _write_handle_notification("left",  settings.getSetting(SETTINGS_KEY_LEFT_EN,  True))
                    _write_handle_notification("right", settings.getSetting(SETTINGS_KEY_RIGHT_EN, True))
            elif event.action == 'remove':
                if _device_path is not None and event.sys_path == _device_path:
                    _device_path = None
                    _discovery_method = None
                    decky.logger.info("[lgo2-vibe] device disconnected")
    except asyncio.CancelledError:
        pass


# ------------------------------------------------------------------ #
# Plugin class
# ------------------------------------------------------------------ #

class Plugin:

    async def _main(self):
        global _monitor_task
        decky.logger.info(f"[lgo2-vibe] startup  pyudev={_PYUDEV}")
        settings.read()
        level    = settings.getSetting(SETTINGS_KEY_LEVEL,    DEFAULT_LEVEL)
        left_en  = settings.getSetting(SETTINGS_KEY_LEFT_EN,  True)
        right_en = settings.getSetting(SETTINGS_KEY_RIGHT_EN, True)
        decky.logger.info(
            f"[lgo2-vibe] level={level} ({_int_to_level(level)}) "
            f"left={left_en} right={right_en}"
        )
        mode     = settings.getSetting(SETTINGS_KEY_MODE,     DEFAULT_MODE)
        _write_rumble_intensity(level)
        _write_rumble_mode(mode)
        _write_handle_notification("left",  left_en)
        _write_handle_notification("right", right_en)
        _monitor_task = asyncio.ensure_future(_monitor_hotplug())

    async def _unload(self):
        global _monitor_task
        if _monitor_task:
            _monitor_task.cancel()
            try:
                await _monitor_task
            except asyncio.CancelledError:
                pass
            _monitor_task = None
        decky.logger.info("[lgo2-vibe] unloaded")

    # ---- RPC surface ------------------------------------------------ #

    async def get_settings(self) -> dict:
        settings.read()
        return {
            "level":         settings.getSetting(SETTINGS_KEY_LEVEL,    DEFAULT_LEVEL),
            "left_enabled":  settings.getSetting(SETTINGS_KEY_LEFT_EN,  True),
            "right_enabled": settings.getSetting(SETTINGS_KEY_RIGHT_EN, True),
            "mode":          settings.getSetting(SETTINGS_KEY_MODE,     DEFAULT_MODE),
        }

    async def set_intensity(self, level: int) -> dict:
        level = max(0, min(3, int(level)))
        settings.setSetting(SETTINGS_KEY_LEVEL, level)
        settings.commit()
        ok = _write_rumble_intensity(level)
        return {"success": ok, "level": level}

    async def set_handle_enabled(self, handle: str, enabled: bool) -> dict:
        key = SETTINGS_KEY_LEFT_EN if handle == "left" else SETTINGS_KEY_RIGHT_EN
        settings.setSetting(key, bool(enabled))
        settings.commit()
        ok = _write_handle_notification(handle, bool(enabled))
        return {"success": ok, "handle": handle, "enabled": bool(enabled)}

    async def set_rumble_mode(self, mode_idx: int) -> dict:
        mode_idx = max(0, min(len(RUMBLE_MODES) - 1, int(mode_idx)))
        settings.setSetting(SETTINGS_KEY_MODE, mode_idx)
        settings.commit()
        ok = _write_rumble_mode(mode_idx)
        return {"success": ok, "mode": mode_idx}

    async def reset_to_default(self) -> dict:
        level_res = await self.set_intensity(DEFAULT_LEVEL)
        mode_res  = await self.set_rumble_mode(DEFAULT_MODE)
        return {
            "success": level_res["success"] and mode_res["success"],
            "level":   DEFAULT_LEVEL,
            "mode":    DEFAULT_MODE,
        }

    async def get_driver_status(self) -> dict:
        p = _get_device_path()
        decky.logger.info(f"[lgo2-vibe] get_driver_status → path={p!r}  pyudev={_PYUDEV}  method={_discovery_method!r}")
        return {"found": p is not None, "paths": [p] if p else [], "method": _discovery_method or ""}

    async def test_vibration(self, duration_ms: int = 500) -> dict:
        settings.read()
        level    = settings.getSetting(SETTINGS_KEY_LEVEL,    DEFAULT_LEVEL)
        left_en  = settings.getSetting(SETTINGS_KEY_LEFT_EN,  True)
        right_en = settings.getSetting(SETTINGS_KEY_RIGHT_EN, True)

        if not left_en and not right_en:
            decky.logger.info("[lgo2-vibe] test_vibration: both handles disabled, skipping")
            return {"success": True}

        # Re-apply handle state so the FF event sees the correct enable flags
        p = _get_device_path()
        if p:
            _write_handle_notification("left",  left_en)
            _write_handle_notification("right", right_en)

        intensity_pct = [0, 33, 66, 100][max(0, min(3, level))]
        duration = max(100, min(2000, int(duration_ms)))
        mag = int(0xFFFF * intensity_pct / 100)

        ff_path = _find_ff_device()
        if ff_path is None:
            decky.logger.warning("[lgo2-vibe] test_vibration: no FF device found")
            return {"success": False, "error": "No rumble-capable input device found"}

        try:
            fd = os.open(ff_path, os.O_RDWR)
            try:
                effect_buf = bytearray(struct.pack(
                    '<HhHHHHHxxHH28x',
                    _FF_RUMBLE, -1, 0,
                    0, 0,
                    duration, 0,
                    mag, mag,
                ))
                fcntl.ioctl(fd, _EVIOCSFF, effect_buf)
                effect_id = struct.unpack_from('<h', effect_buf, 2)[0]

                def _input_event(ev_type: int, code: int, value: int) -> bytes:
                    t = time.time()
                    return struct.pack('<qqHHi', int(t), int((t % 1) * 1e6),
                                      ev_type, code, value)

                os.write(fd, _input_event(_EV_FF, effect_id, 1))
                await asyncio.sleep(duration / 1000.0)
                os.write(fd, _input_event(_EV_FF, effect_id, 0))
                fcntl.ioctl(fd, _EVIOCRMFF, struct.pack('<i', effect_id))

                decky.logger.info(
                    f"[lgo2-vibe] test_vibration: level={level} ({intensity_pct}%) "
                    f"duration={duration}ms via {ff_path}"
                )
                return {"success": True}
            finally:
                os.close(fd)
        except Exception as exc:
            decky.logger.error(f"[lgo2-vibe] test_vibration failed: {exc}")
            return {"success": False, "error": str(exc)}

import decky
import os
import glob
import asyncio
import struct
import fcntl
from settings import SettingsManager

# ------------------------------------------------------------------ #
# Constants
# ------------------------------------------------------------------ #

# hid-lenovo-go driver sysfs paths (Linux 7.1+, mainline since March 2026)
# The driver exposes string-based levels, not 0-100 integers.
RUMBLE_GLOBS = [
    "/sys/module/hid_lenovo_go/drivers/hid:*/rumble_intensity",
    "/sys/bus/hid/drivers/hid-lenovo-go/*/rumble_intensity",
]

LEFT_NOTIFY_GLOBS = [
    "/sys/module/hid_lenovo_go/drivers/hid:*/left_handle/rumble_notification",
    "/sys/bus/hid/drivers/hid-lenovo-go/*/left_handle/rumble_notification",
]

RIGHT_NOTIFY_GLOBS = [
    "/sys/module/hid_lenovo_go/drivers/hid:*/right_handle/rumble_notification",
    "/sys/bus/hid/drivers/hid-lenovo-go/*/right_handle/rumble_notification",
]

# Intensity levels as accepted by the driver (index maps to slider 0-3)
LEVEL_NAMES = ["off", "low", "medium", "high"]
DEFAULT_LEVEL = 2  # medium

SETTINGS_KEY_LEVEL = "intensity_level"
SETTINGS_KEY_LEFT_EN = "left_enabled"
SETTINGS_KEY_RIGHT_EN = "right_enabled"

settings = SettingsManager(
    name="settings",
    settings_directory=decky.DECKY_PLUGIN_SETTINGS_DIR,
)

# Force-feedback ioctl numbers (Linux x86-64, sizeof(ff_effect) == 48)
_EVIOCGBIT_FF = 0x80204535
_EVIOCSFF     = 0x40304580
_EVIOCRMFF    = 0x40044581
_EV_FF        = 0x15
_FF_RUMBLE    = 0x50


# ------------------------------------------------------------------ #
# Helpers
# ------------------------------------------------------------------ #

def _find_paths(globs: list) -> list:
    """Return all unique paths matching any of the given glob patterns."""
    found = []
    for pattern in globs:
        for match in glob.glob(pattern):
            if match not in found:
                found.append(match)
    return found


def _int_to_level(value: int) -> str:
    return LEVEL_NAMES[max(0, min(3, int(value)))]


def _level_to_int(level: str) -> int:
    try:
        return LEVEL_NAMES.index(level.strip())
    except ValueError:
        return DEFAULT_LEVEL


def _write_all(paths: list, payload: str) -> bool:
    ok = True
    for path in paths:
        try:
            with open(path, "w") as f:
                f.write(payload + "\n")
            decky.logger.info(f"[lgo2-vibe] wrote '{payload}' -> {path}")
        except OSError as exc:
            decky.logger.error(f"[lgo2-vibe] write failed ({path}): {exc}")
            ok = False
    return ok


def _write_rumble_intensity(level_int: int) -> bool:
    level = _int_to_level(level_int)
    paths = _find_paths(RUMBLE_GLOBS)
    if not paths:
        decky.logger.warning("[lgo2-vibe] No rumble_intensity sysfs paths found")
        return False
    return _write_all(paths, level)


def _write_handle_notification(handle: str, enabled: bool) -> bool:
    globs = LEFT_NOTIFY_GLOBS if handle == "left" else RIGHT_NOTIFY_GLOBS
    paths = _find_paths(globs)
    if not paths:
        decky.logger.warning(f"[lgo2-vibe] No {handle}_handle/rumble_notification path found")
        return False
    return _write_all(paths, "true" if enabled else "false")


def _find_ff_device() -> str | None:
    """Return the first /dev/input/eventX that advertises FF_RUMBLE capability."""
    for path in sorted(glob.glob('/dev/input/event*')):
        try:
            with open(path, 'rb') as fh:
                bits = bytearray(32)
                fcntl.ioctl(fh.fileno(), _EVIOCGBIT_FF, bits)
                if bits[_FF_RUMBLE // 8] & (1 << (_FF_RUMBLE % 8)):
                    decky.logger.info(f"[lgo2-vibe] FF device: {path}")
                    return path
        except Exception:
            pass
    return None


# ------------------------------------------------------------------ #
# Plugin class
# ------------------------------------------------------------------ #

class Plugin:

    async def _main(self):
        settings.read()
        level    = settings.getSetting(SETTINGS_KEY_LEVEL,    DEFAULT_LEVEL)
        left_en  = settings.getSetting(SETTINGS_KEY_LEFT_EN,  True)
        right_en = settings.getSetting(SETTINGS_KEY_RIGHT_EN, True)
        decky.logger.info(
            f"[lgo2-vibe] startup - level={level} ({_int_to_level(level)}) "
            f"left_en={left_en} right_en={right_en}"
        )
        _write_rumble_intensity(level)
        _write_handle_notification("left",  left_en)
        _write_handle_notification("right", right_en)

    async def _unload(self):
        decky.logger.info("[lgo2-vibe] unloaded")

    # ---- RPC surface ------------------------------------------------ #

    async def get_settings(self) -> dict:
        settings.read()
        return {
            "level":         settings.getSetting(SETTINGS_KEY_LEVEL,    DEFAULT_LEVEL),
            "left_enabled":  settings.getSetting(SETTINGS_KEY_LEFT_EN,  True),
            "right_enabled": settings.getSetting(SETTINGS_KEY_RIGHT_EN, True),
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

    async def reset_to_default(self) -> dict:
        return await self.set_intensity(DEFAULT_LEVEL)

    async def get_driver_status(self) -> dict:
        paths = _find_paths(RUMBLE_GLOBS)
        return {"found": len(paths) > 0, "paths": paths}

    async def test_vibration(self, duration_ms: int = 500) -> dict:
        """
        Fire a short rumble via the Linux evdev force-feedback interface.
        Uses FF_RUMBLE — device-agnostic, works regardless of sysfs availability.
        Magnitude is derived from the saved intensity level (0/33/66/100%).
        """
        settings.read()
        level = settings.getSetting(SETTINGS_KEY_LEVEL, DEFAULT_LEVEL)
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

                import time
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

# LeGo Vibe Control — project context for Claude

Decky Loader plugin for Lenovo Legion Go 2. Controls vibration intensity and mode via the `hid-lenovo-go` kernel driver sysfs interface. Requires SteamOS 3.8+ / Kernel 6.18+.

## File structure

| File | Role |
|---|---|
| `main.py` | Python backend — all sysfs writes, RPC surface, device discovery |
| `src/index.tsx` | TypeScript source (JSX) |
| `dist/index.js` | Compiled frontend — **kept in sync with src manually** (no build step needed for distribution) |
| `plugin.json` | Decky metadata — name, author, flags (root required for sysfs) |
| `package.json` | Version field lives here (`1.1.0`) |
| `requirements.txt` | Contains `pyudev` — processed by Decky pip, but pyudev is also bundled |
| `pyudev/` | Bundled pyudev 0.24.4 (pure Python) — ensures it's available without pip/network |
| `LeGo-Vibe-Control.zip` | Distribution zip — rebuild after any change (see below) |

## Sysfs attributes (hid-lenovo-go driver)

All write-only (mode 0200) — use `os.path.exists()` to detect, never `dev.attributes.asstring()`.

```
<device_path>/rumble_intensity                  — off | low | medium | high  (global)
<device_path>/left_handle/rumble_notification   — true | false
<device_path>/right_handle/rumble_notification  — true | false
<device_path>/left_handle/rumble_mode           — fps | racing | standard | spg | rpg
<device_path>/right_handle/rumble_mode          — fps | racing | standard | spg | rpg
```

Note: `rumble_notification` controls notification-type vibrations only. It does NOT gate FF_RUMBLE force-feedback events — hardware FF fires on both handles regardless.

## Device discovery

`_discover()` returns `(path, method)`. Tries pyudev first, then two glob patterns:
- `pyudev` — `list_devices(subsystem='hid')` + `os.path.exists(dev.sys_path + '/rumble_intensity')`
- `glob-hid` — `/sys/bus/hid/drivers/*/*/rumble_intensity` (two wildcards required)
- `glob-module` — `/sys/module/*/drivers/hid:*/rumble_intensity`

`dev.driver` is always `None` for HID subsystem devices — never filter by driver name via pyudev.

## pyudev bundling

pyudev is bundled in `pyudev/` because Decky may not run `pip install` for sideloaded zips. `main.py` explicitly adds `os.path.dirname(__file__)` to `sys.path` at module level before importing pyudev.

## Rebuilding the zip

Run in PowerShell from the project root (or just paste into terminal):

```powershell
$root = (Get-Location).Path
$out  = "$root\LeGo-Vibe-Control.zip"
if (Test-Path $out) { Remove-Item $out -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($out, 'Create')
$folder = "LeGo Vibe Control"
@("plugin.json","main.py","requirements.txt","package.json") | ForEach-Object {
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, "$root\$_", "$folder/$_", 'Optimal') | Out-Null
}
[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, "$root\dist\index.js", "$folder/dist/index.js", 'Optimal') | Out-Null
Get-ChildItem "$root\pyudev" -Recurse -Filter "*.py" | Where-Object { $_.FullName -notmatch '__pycache__' } | ForEach-Object {
    $rel = $_.FullName.Substring($root.Length + 1).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, "$folder/$rel", 'Optimal') | Out-Null
}
$zip.Dispose()
Write-Host "Done ($([math]::Round((Get-Item $out).Length/1KB,1)) KB)"
```

Zip must contain: `plugin.json`, `main.py`, `requirements.txt`, `package.json`, `dist/index.js`, `pyudev/**/*.py` — all inside a folder named exactly `LeGo Vibe Control`.

## RPC surface (main.py ↔ dist/index.js)

| Python method | JS callable | Notes |
|---|---|---|
| `get_settings` | `getSettings()` | Returns level, mode, left/right enabled |
| `set_intensity(level)` | `setIntensity(val)` | 0–3 |
| `set_rumble_mode(mode_idx)` | `setRumbleMode(val)` | 0–4 |
| `set_handle_enabled(handle, enabled)` | `setHandleEnabled(h, v)` | handle = "left" or "right" |
| `reset_to_default` | `resetToDefault()` | Resets level=2 (medium), mode=0 (fps) |
| `get_driver_status` | `getDriverStatus()` | Returns found, paths, method |
| `test_vibration(duration_ms)` | `testVibration(ms)` | FF_RUMBLE via evdev |

## Known limitations

- `test_vibration` uses FF_RUMBLE which fires on both handles — per-handle toggles (`rumble_notification`) do not affect hardware FF. This is a kernel driver limitation, not fixable in userspace.
- Hotplug monitor requires pyudev. With glob-only fallback, hotplug re-apply doesn't work (irrelevant for Legion Go 2 since controller is built-in).

## History / what changed from the original fork

- Replaced hardcoded sysfs paths with pyudev + driver-agnostic glob discovery
- Added vibration mode slider (fps/racing/standard/spg/rpg) — global, both handles
- Bundled pyudev to avoid pip dependency
- Added 5s init timeout to prevent infinite loading if backend crashes
- Added discovery method display in UI ("via: pyudev" etc.)
- Fixed `global _discovery_method` declaration in `_monitor_hotplug`

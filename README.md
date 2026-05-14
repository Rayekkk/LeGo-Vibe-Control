# LeGo Vibe Control

A [Decky Loader](https://decky.xyz) plugin for the **Lenovo Legion Go 2** that lets you control vibration intensity and pattern on both grip handles.

---

## Features

- **Intensity slider** — four levels: Off / Low / Medium / High
- **Mode slider** — five vibration patterns: FPS / Racing / Standard / SPG / RPG (applied globally to both handles)
- **Per-controller toggles** — enable or disable rumble on left and right handle independently
- **Test button** — fire a 0.5-second rumble so you can feel the current intensity and mode
- **Driver status** — green dot when the `hid-lenovo-go` sysfs endpoint is detected, with the discovery method shown
- **Persistent** — settings are written back to the hardware on every Decky startup

---

## Requirements

| Requirement | Details |
|---|---|
| Device | Lenovo Legion Go 2 |
| OS | SteamOS 3.8+ / Kernel 6.18+ |
| Kernel driver | `hid-lenovo-go` (mainline since Kernel 6.18, March 2026) |
| Plugin loader | [Decky Loader](https://decky.xyz) |

---

## Installation

### Easy install (recommended)

1. Install [Decky Loader](https://decky.xyz) if you haven't already.
2. Download `LeGo-Vibe-Control.zip` from the [Releases](../../releases) page.
3. In Gaming Mode, open the **Quick Access Menu** (the `…` button).
4. Open the Decky menu → scroll to the bottom → **Developer** → **Install Plugin from ZIP**.
5. Select the downloaded zip.

### From source

```bash
git clone <this-repo>
cd <repo>/src
pnpm install
pnpm run build
cd ..
cp -r . ~/homebrew/plugins/"LeGo Vibe Control"
systemctl --user restart plugin_loader
```

Requires Node.js 16.14+ and pnpm v9 (`npm install -g pnpm@9`).

---

## Usage

Open the **Quick Access Menu** and tap the vibration icon.

**Intensity**
Move the slider to one of four levels: Off, Low, Medium, High. Applied immediately via the `rumble_intensity` sysfs attribute.

**Mode**
Selects the vibration pattern: FPS, Racing, Standard, SPG, RPG. Written to `rumble_mode` on both handles simultaneously.

**Left / Right controller toggles**
Independently enable or disable rumble on each handle. Writes to `left_handle/rumble_notification` and `right_handle/rumble_notification`. Note: these toggles control notification-type vibrations; the Test button uses hardware force-feedback which fires on both handles regardless.

**Test Vibration**
Fires a 0.5-second rumble via the Linux evdev force-feedback interface so you can feel the current intensity and mode. Always fires on both handles — per-handle toggles do not apply to hardware FF.

**Reset to defaults**
Restores intensity to Medium and mode to FPS.

---

## How it works

The plugin writes to the `hid-lenovo-go` kernel driver's sysfs attributes. Device detection uses pyudev (bundled) with a glob fallback — no driver name is hardcoded:

```
# Intensity (both handles)
.../rumble_intensity          — off | low | medium | high

# Per-handle notification toggle
.../left_handle/rumble_notification   — true | false
.../right_handle/rumble_notification  — true | false

# Per-handle vibration mode
.../left_handle/rumble_mode           — fps | racing | standard | spg | rpg
.../right_handle/rumble_mode          — fps | racing | standard | spg | rpg
```

The plugin runs as root (required for sysfs writes) and uses Decky's `SettingsManager` to persist settings across reboots.

---

## Troubleshooting

### Driver Status shows a red dot

```bash
# Check the driver is loaded
lsmod | grep hid_lenovo_go

# Check the sysfs paths exist
ls /sys/bus/hid/drivers/hid-lenovo-go/*/rumble_intensity 2>/dev/null
```

The `hid-lenovo-go` driver requires SteamOS 3.8+ / Kernel 6.18+. Check your kernel version with `uname -r`.

### Sliders move but vibration doesn't change

```bash
# Test the sysfs write manually
echo "medium" | sudo tee /sys/bus/hid/drivers/hid-lenovo-go/*/rumble_intensity

# Check plugin logs
sudo cat ~/homebrew/logs/"LeGo Vibe Control"/*.log | tail -30
```

---

## Credits

- Kernel driver: `hid-lenovo-go` by Derek J. Clark, merged into Kernel 6.18 (SteamOS 3.8+)

---

## License

MIT — see [LICENSE](LICENSE).

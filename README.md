# LeGo Vibe Control

A [Decky Loader](https://decky.xyz) plugin for the **Lenovo Legion Go 2** that lets you control vibration intensity, pattern, and touchpad haptics.

Created for the **Legion Go 2** and tested on the **Legion Go 2 Z2E**. May also work on the original Legion Go 1, but this has not been tested.

---

## Features

- **Intensity slider** — four levels: Off / Low / Medium / High
- **Mode slider** — five vibration patterns: FPS / Racing / Standard / SPG / RPG (applied globally to both handles)
- **Touchpad haptics toggle** — enable or disable touchpad vibration independently from the controllers
- **Touchpad intensity slider** — separate four-level intensity control for the touchpad
- **Test button** — fire a 0.5-second rumble so you can feel the current intensity and mode
- **Driver status** — green dot when the `hid-lenovo-go` sysfs endpoint is detected
- **Persistent** — settings are written back to the hardware on every Decky startup

---

## Requirements

| Requirement | Details |
|---|---|
| Device | Lenovo Legion Go 2 |
| OS | SteamOS 3.8+ / Kernel 6.18+ |
| Kernel driver | `hid-lenovo-go` (mainline since Kernel 6.18, March 2026) |
| Plugin loader | [Decky Loader](https://decky.xyz) |

> **Legion Go S is not supported.** Its `hid-lenovo-go-s` driver does not expose vibration control via sysfs.

---

## Installation

### Easy install (recommended)

1. Install [Decky Loader](https://decky.xyz) if you haven't already.
2. Download `LeGo-Vibe-Control-x.x.x.zip` from the [Releases](../../releases) page.
3. In Gaming Mode, open the **Quick Access Menu** (the `…` button).
4. Open the Decky menu → scroll to the bottom → **Developer** → **Install Plugin from ZIP**.
5. Select the downloaded zip.

The zip contains a single `LeGo-Vibe-Control` folder — Decky installs it automatically.

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
Move the slider to one of four levels: Off, Low, Medium, High. Applied immediately via the `rumble_intensity` sysfs attribute. Does not affect the touchpad — use the dedicated touchpad slider for that.

**Mode**
Selects the vibration pattern for the controller handles: FPS, Racing, Standard, SPG, RPG. Written to `rumble_mode` on both handles simultaneously.

**Touchpad vibration**
Toggle and intensity slider for the touchpad haptic motor, independent from the controller handles. Setting controller intensity to Off does not silence the touchpad.

**Test Vibration**
Fires a 0.5-second rumble via the Linux evdev force-feedback interface so you can feel the current intensity and mode.

**Reset to defaults**
Restores all settings to defaults: intensity Medium, mode FPS, touchpad intensity Medium, touchpad enabled.

---

## How it works

The plugin writes to the `hid-lenovo-go` kernel driver's sysfs attributes. Device detection uses pyudev (bundled) with a glob fallback — no driver name is hardcoded:

```
# Controller intensity (both handles)
.../rumble_intensity                   — off | low | medium | high

# Vibration mode (both handles)
.../left_handle/rumble_mode            — fps | racing | standard | spg | rpg
.../right_handle/rumble_mode           — fps | racing | standard | spg | rpg

# Touchpad haptics
.../touchpad/vibration_intensity       — off | low | medium | high
.../touchpad/vibration_enabled         — true | false
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
journalctl -u plugin_loader | grep lego-vibe | tail -30
```

---

## Credits

- Kernel driver: `hid-lenovo-go` by Derek J. Clark, merged into Kernel 6.18 (SteamOS 3.8+)

---

## License

MIT — see [LICENSE](LICENSE).

---

*Created with the help of [Claude](https://claude.ai) 🤖*

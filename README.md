# LeGo Vibe Control

A [Decky Loader](https://decky.xyz) plugin for the **Lenovo Legion Go** and **Legion Go 2** that lets you control vibration intensity, pattern, and touchpad haptics.

Designed for the **Lenovo Legion Go** and **Legion Go 2**. Tested on the **Legion Go 2 Z2E**.

---

## Features

- **Intensity slider** - four levels: Off / Low / Medium / High
- **Mode slider** - five vibration patterns: FPS / Racing / Standard / SPG / RPG (applied to both handles)
- **Touchpad haptics toggle** - enable or disable touchpad vibration independently from the controllers
- **Touchpad intensity slider** - separate four-level intensity control for the touchpad
- **Per-game profiles** - override the global settings for a specific game; the profile is applied automatically when that game starts and reverted when it exits
- **Test button** - fire a 0.5-second rumble so you can feel the current intensity and mode
- **Driver status** - green dot when the `hid-lenovo-go` sysfs endpoint is detected
- **Persistent** - settings are written back to the hardware on Decky startup, after resuming from sleep, and whenever the controller reconnects
- **In-plugin updates** - checks GitHub releases and downloads the zip for you

---

## Requirements

| Requirement | Details |
|---|---|
| Device | Lenovo Legion Go / Legion Go 2 |
| OS | SteamOS 3.8+ / Kernel 6.18+ |
| Kernel driver | `hid-lenovo-go` (mainline since Kernel 6.18, March 2026) |
| Plugin loader | [Decky Loader](https://decky.xyz) |

> **Legion Go S is not supported.** Its `hid-lenovo-go-s` driver does not expose vibration control via sysfs (as of May 14, 2026, SteamOS 3.9).

---

## Installation

### Easy install (recommended)

1. Install [Decky Loader](https://decky.xyz) if you haven't already.
2. Download `LeGo-Vibe-Control-x.x.x.zip` from the [Releases](../../releases) page.
3. In Gaming Mode, open the **Quick Access Menu** (the `…` button).
4. Open the Decky menu, scroll to the bottom, then **Developer** -> **Install Plugin from ZIP**.
5. Select the downloaded zip.

The zip contains a single `LeGo-Vibe-Control` folder - Decky installs it automatically.

### From source

Requires Node.js 18+.

```bash
git clone https://github.com/Rayekkk/LeGo-Vibe-Control
cd LeGo-Vibe-Control

npm install
npm run build      # bundles src/index.tsx into dist/
npm run package    # produces LeGo-Vibe-Control-<version>.zip
```

Then install the resulting zip through Decky's **Install Plugin from ZIP**, which is the supported path and avoids permission problems.

To copy the files directly instead, install only the runtime payload - copying the whole checkout would drag in `.git/`, `src/` and `node_modules/`:

```bash
DEST=~/homebrew/plugins/LeGo-Vibe-Control
sudo mkdir -p "$DEST"
sudo cp -r main.py updater.py plugin.json package.json README.md LICENSE NOTICE dist pyudev "$DEST"
sudo systemctl restart plugin_loader
```

---

## Usage

Open the **Quick Access Menu** and tap the vibration icon.

**Intensity**
Move the slider to one of four levels: Off, Low, Medium, High. Applied immediately via the `rumble_intensity` sysfs attribute. This does not affect the touchpad - use the dedicated touchpad slider for that.

**Mode**
Selects the vibration pattern for the controller handles: FPS, Racing, Standard, SPG, RPG. Written to `rumble_mode` on both handles simultaneously. The controller demonstrates the new pattern by itself when the mode changes; the plugin does not add a buzz of its own.

**Touchpad vibration**
Toggle and intensity slider for the touchpad haptic motor, independent from the controller handles. Setting controller intensity to Off does not silence the touchpad.

**Per-game profiles**
Launch a game, then turn on **Per Game Profile**. The settings you pick from that point on are stored against that game and applied automatically every time it runs. Turn the toggle off to fall back to the global profile.

**Test Vibration**
Fires a 0.5-second rumble via the Linux evdev force-feedback interface so you can feel the current intensity and mode. The plugin picks the evdev node whose USB vendor:product matches the detected controller, so it will not rumble some other pad you have plugged in.

**Reset to defaults**
Restores the active profile to defaults: intensity Medium, mode FPS, touchpad intensity Medium, touchpad enabled.

---

## How it works

The plugin writes to the `hid-lenovo-go` kernel driver's sysfs attributes. Device detection uses pyudev (bundled) with a glob fallback - no driver name is hardcoded:

```
# Controller intensity (both handles)
.../rumble_intensity                   - off | low | medium | high

# Vibration mode (both handles)
.../left_handle/rumble_mode            - fps | racing | standard | spg | rpg
.../right_handle/rumble_mode           - fps | racing | standard | spg | rpg

# Touchpad haptics
.../touchpad/vibration_intensity       - off | low | medium | high
.../touchpad/vibration_enabled         - true | false
```

The legal values for each attribute are read from the driver's sibling `<attribute>_index` files at runtime rather than hardcoded, so a kernel update that adds a new mode shows up without a plugin release.

The driver does not reliably reflect written values on read - `rumble_intensity` returns the value from *before* the last write - so the plugin tracks what it wrote in memory instead of reading back. Anything that can reset the hardware (resuming from sleep, reconnecting the controller) clears that cache and forces a full rewrite.

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

Note that reading the attribute back is not a valid check - the driver reports a stale value. Trust the plugin log lines instead.

---

## Development

```bash
npm run build       # bundle the frontend into dist/
npm run watch       # rebuild on change
npm run typecheck   # TypeScript check with no emit
npm run package     # build the release zip
```

The frontend is built with [`@decky/rollup`](https://www.npmjs.com/package/@decky/rollup), the official Decky preset, which maps `react`, `react/jsx-runtime`, `react-dom` and `@decky/ui` onto the globals Steam injects rather than bundling them.

`updater.py` is shared verbatim with [LeGoTDP](https://github.com/Rayekkk/LeGoTDP) - change it in one repo and copy it to the other.

CI builds every push and pull request. Pushing a tag such as `1.5.0` builds the zip and publishes a GitHub release; the tag must match the `version` in both `plugin.json` and `package.json`.

---

## Credits

- Kernel driver: `hid-lenovo-go` by Derek J. Clark, merged into Kernel 6.18 (SteamOS 3.8+)
- Bundled [pyudev](https://github.com/pyudev/pyudev) is LGPL-2.1 - see [NOTICE](NOTICE)

---

## License

MIT - see [LICENSE](LICENSE). Third-party components are listed in [NOTICE](NOTICE).

---

*Vibe coded with the help of [Claude](https://claude.ai) 🤖*

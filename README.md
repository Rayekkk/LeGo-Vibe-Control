# Ally Vibe Control

A [Decky Loader](https://decky.xyz) plugin for the **ROG Xbox Ally X** that lets you dial in exactly how hard the grip motors vibrate — or turn them off entirely. SteamOS gives you no built-in control over this; motors default to 100% which many people find uncomfortably strong.

Settings persist across reboots.

---

## Features

- **Single slider** — link both motors and control them together
- **Split control** — set left and right motors independently
- **Quick presets** — disable vibration (0%), restore default (50%), or go full intensity (100%)
- **Test button** — fire a 0.5-second rumble so you can feel the current setting before committing
- **Driver status** — green dot when the `asus_ally_hid` sysfs endpoint is detected, red if not
- **Persistent** — your chosen intensity is written back to the hardware on every Decky startup

---

## Requirements

| Requirement | Details |
|---|---|
| Device | ROG Xbox Ally X |
| OS | SteamOS 3.7 or later |
| Kernel driver | `asus_ally_hid` (included in SteamOS 3.7+) |
| Plugin loader | [Decky Loader](https://decky.xyz) |

> **Ally (non-X) / other devices** — the plugin will load but the Driver Status indicator will show red if your kernel doesn't expose the `asus_ally_hid` sysfs endpoint.

---

## Installation

### Easy install (recommended)

1. Install [Decky Loader](https://decky.xyz) if you haven't already.
2. Go to the [Releases](https://github.com/piyush-tyagi-13/ally-vibe-control/releases) page and download `ally-vibe-control-vX.X.X.zip`.
3. In Gaming Mode, open the **Quick Access Menu** (the `…` button).
4. Open the Decky menu → scroll to the bottom → **Developer** → **Install Plugin from ZIP**.
5. Select the zip you downloaded.
6. The 📳 icon will appear in the Quick Access Menu.

### From source

```bash
# Clone the repo
git clone https://github.com/piyush-tyagi-13/ally-vibe-control.git
cd ally-vibe-control

# Install dependencies and build
cd src
pnpm install
pnpm run build
cd ..

# Copy to Decky plugins directory
cp -r . ~/homebrew/plugins/ally-vibe-control

# Restart Decky
systemctl --user restart plugin_loader
```

Requires Node.js 16.14+ and pnpm v9 (`npm install -g pnpm@9`).

---

## Usage

Open the **Quick Access Menu** and tap the 📳 icon.

**Linked mode (default)**
The toggle at the top keeps both motors in sync. Move the single slider to set intensity for both grips at once.

**Split mode**
Toggle off "Link both motors" to reveal separate sliders for left and right. Useful if one grip feels stronger than the other, or you just prefer an asymmetric feel.

**Test Vibration**
Fires a short rumble at the current intensity so you can feel the result without having to launch a game. Adjust → test → repeat until it feels right.

**Disable / Full / Reset**
Three quick-action buttons at the bottom:
- **Disable vibration (0%)** — kills motors entirely
- **Full intensity (100%)** — restores factory behavior
- **Reset to 50% (default)** — the recommended starting point

---

## How it works

The plugin writes to the `asus_ally_hid` kernel driver's sysfs endpoint:

```
/sys/module/hid_asus_ally/drivers/hid:asus_rog_ally/*/vibration_intensity
```

The value is a pair of integers (`LEFT RIGHT`, each 0–100) that scale the motor output. The plugin runs as root (required for sysfs writes) and uses Decky's `SettingsManager` to persist your chosen values so they are restored on every boot.

A fallback glob (`/sys/class/hidraw/*/device/vibration_intensity`) is tried if the primary path isn't found, since hidraw node numbers aren't stable across reboots.

---

## Known limitations

**Trigger / impulse vibration is not controllable.**
The grip motors (the ones that hum continuously during gameplay) are fully controllable. The trigger click-vibration is a separate hardware path that the kernel driver does not yet expose via sysfs. This is a known upstream limitation tracked in [Valve issue #12673](https://github.com/ValveSoftware/steam-for-linux/issues/12673). When kernel support lands, this plugin will be updated.

---

## Troubleshooting

### Plugin doesn't appear in the Quick Access Menu

```bash
# Check the plugin is in the right place
ls ~/homebrew/plugins/ally-vibe-control/

# Check the frontend bundle exists
ls ~/homebrew/plugins/ally-vibe-control/dist/index.js

# Check Decky is running
systemctl status plugin_loader

# Restart Decky
systemctl --user restart plugin_loader
```

### Driver Status shows a red dot

```bash
# Check the driver is loaded
lsmod | grep asus_ally

# Check the sysfs path exists
ls /sys/module/hid_asus_ally/drivers/hid:asus_rog_ally/*/vibration_intensity 2>/dev/null
ls /sys/class/hidraw/*/device/vibration_intensity 2>/dev/null
```

If the driver is missing, check your kernel version (`uname -r`). SteamOS 3.7+ on Ally hardware should include it.

### Sliders move but vibration doesn't change

```bash
# Test the sysfs write manually as root (adjust hidraw number as needed)
echo "30 30" | sudo tee /sys/class/hidraw/hidraw2/device/vibration_intensity

# Check plugin logs
sudo cat ~/homebrew/logs/ally-vibe-control/*.log | tail -30
```

If the manual write works but the plugin doesn't, verify `plugin.json` contains `"flags": ["root"]`.

---

## Building a release

Tag a commit and push — GitHub Actions handles the rest:

```bash
git tag v1.1.0
git push origin v1.1.0
```

The workflow builds the frontend, packages the zip, and publishes a GitHub Release with install instructions automatically.

---

## License

MIT — see [LICENSE](LICENSE).

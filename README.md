# Legion Go 2 Vibe Control

A [Decky Loader](https://decky.xyz) plugin for the **Lenovo Legion Go 2** that lets you control how hard the grip motors vibrate — or turn them off entirely.

> **Fork notice** — this plugin is a fork of [ally-vibe-control](https://github.com/piyush-tyagi-13/ally-vibe-control) by [piyush-tyagi-13](https://github.com/piyush-tyagi-13), originally written for the ASUS ROG Ally X. Huge thanks for the clean architecture and the Decky integration — it made porting this to Legion hardware straightforward. Original plugin licensed under MIT.

---

## Features

- **Intensity slider** — four levels: Off / Low / Medium / High
- **Per-controller toggles** — enable or disable rumble on left and right handle independently
- **Test button** — fire a 0.5-second rumble so you can feel the current setting before committing
- **Driver status** — green dot when the `hid-lenovo-go` sysfs endpoint is detected, red if not
- **Persistent** — your chosen settings are written back to the hardware on every Decky startup

---

## Requirements

| Requirement | Details |
|---|---|
| Device | Lenovo Legion Go 2 |
| OS | SteamOS with Linux 7.1+ kernel |
| Kernel driver | `hid-lenovo-go` (mainline since Linux 7.1, March 2026) |
| Plugin loader | [Decky Loader](https://decky.xyz) |

---

## Installation

### Easy install (recommended)

1. Install [Decky Loader](https://decky.xyz) if you haven't already.
2. Download `legion-vibe-control.zip` from the [Releases](../../releases) page.
3. In Gaming Mode, open the **Quick Access Menu** (the `…` button).
4. Open the Decky menu → scroll to the bottom → **Developer** → **Install Plugin from ZIP**.
5. Select the downloaded zip.

### From source

```bash
git clone <this-repo>
cd legion-vibe-control/src
pnpm install
pnpm run build
cd ..
cp -r . ~/homebrew/plugins/legion-vibe-control
systemctl --user restart plugin_loader
```

Requires Node.js 16.14+ and pnpm v9 (`npm install -g pnpm@9`).

---

## Usage

Open the **Quick Access Menu** and tap the vibration icon.

**Intensity**
Move the slider to one of four levels: Off, Low, Medium, High. The setting is applied immediately and maps directly to the `rumble_intensity` sysfs attribute exposed by the `hid-lenovo-go` driver.

**Left / Right controller toggles**
Independently enable or disable rumble on each handle. Writes to `left_handle/rumble_notification` and `right_handle/rumble_notification`.

**Test Vibration**
Fires a short rumble via the Linux evdev force-feedback interface so you can feel the result without launching a game.

**Reset to Medium**
Restores the default intensity level.

---

## How it works

The plugin writes to the `hid-lenovo-go` kernel driver's sysfs endpoints:

```
/sys/module/hid_lenovo_go/drivers/hid:*/rumble_intensity
/sys/module/hid_lenovo_go/drivers/hid:*/left_handle/rumble_notification
/sys/module/hid_lenovo_go/drivers/hid:*/right_handle/rumble_notification
```

`rumble_intensity` accepts string values: `off`, `low`, `medium`, `high`.  
`rumble_notification` accepts `true` or `false`.

The plugin runs as root (required for sysfs writes) and uses Decky's `SettingsManager` to persist settings across reboots.

---

## Troubleshooting

### Driver Status shows a red dot

```bash
# Check the driver is loaded
lsmod | grep hid_lenovo_go

# Check the sysfs paths exist
ls /sys/module/hid_lenovo_go/drivers/hid:*/rumble_intensity 2>/dev/null
ls /sys/bus/hid/drivers/hid-lenovo-go/*/rumble_intensity 2>/dev/null
```

The `hid-lenovo-go` driver requires Linux 7.1+. Check your kernel version with `uname -r`.

### Sliders move but vibration doesn't change

```bash
# Test the sysfs write manually
echo "medium" | sudo tee /sys/module/hid_lenovo_go/drivers/hid:*/rumble_intensity

# Check plugin logs
sudo cat ~/homebrew/logs/legion-vibe-control/*.log | tail -30
```

---

## Credits

- Original plugin: **[ally-vibe-control](https://github.com/piyush-tyagi-13/ally-vibe-control)** by [piyush-tyagi-13](https://github.com/piyush-tyagi-13) — MIT License
- Kernel driver: `hid-lenovo-go` by Derek J. Clark, merged into Linux 7.1

---

## License

MIT — see [LICENSE](LICENSE).

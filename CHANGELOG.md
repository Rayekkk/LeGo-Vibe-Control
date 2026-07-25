# Changelog

All notable changes to LeGo Vibe Control, newest first.

## [1.5.0] - 2026-07-25

Released alongside LeGoTDP 1.5.0.

### Added

- The driver status and the sliders update the moment the controller is plugged in, instead of waiting until the next time you open the panel.
- Uninstalling restores the driver's default vibration settings. The values live in the driver rather than in the plugin, so removing it while intensity was "Off" used to leave a silent controller and nothing left to fix it. See Known issues.

### Fixed

- Settings are restored reliably after the console wakes. The plugin was listening for a Steam notification that no longer exists, and only recovered when the controller happened to re-enumerate on its own; on a wake where it did not, the controller quietly kept the firmware defaults.
- A backend that fails to start now says why. The panel used to show working sliders that quietly did nothing.
- A slider no longer jumps back to its previous position when a write to the driver is slow.
- A per-game profile is no longer left unapplied when a single call to the backend fails; it is retried instead of being assumed to have worked.

### Known issues

- Decky does not reliably give a plugin the chance to run its uninstall step, so the driver defaults are not guaranteed to be restored. If vibration is left somewhere you did not want it, reinstall briefly and use Reset to defaults, or set it in another tool.

### Internal

- Update and download code is shared with LeGoTDP, so a fix to certificate handling, the download allowlist or the release check lands in both plugins at once.
- The settings store is lock-protected, since the controller hotplug monitor and the panel can write to it at the same time.
- Settings migration moved to Decky's `_migration()` lifecycle hook, so it finishes before anything can read the store.

## [1.4.0] - 2026-07-25

Settings from earlier versions are migrated automatically, including any per-game profiles.

### Added

- Driver status refreshes when you open the panel, and shows which controller was matched.
- Version, changelog and build are checked automatically on every release.

### Changed

- Much lighter on battery. The running game was being polled twenty times faster than necessary; it now reacts to Steam's own game start and stop events.
- Vibration modes are read from the driver, so a kernel update that adds a new mode shows up without needing a new plugin release.

### Fixed

- Settings are restored after sleep. The controller comes back at its firmware defaults when the console wakes, and the plugin now notices and re-applies your intensity, mode and touchpad settings instead of assuming they were still in place.
- Changing the vibration mode feels consistent again. The controller already demonstrates the new pattern by itself, and the plugin was playing a second one on top of it, so the same mode felt different every time.
- "Test Vibration" no longer reports failure every time. The effect was played correctly, but the call that cleans it up afterwards was malformed, so every test ended in an error the interface silently swallowed.
- The test button rumbles the right controller. It used to pick the first rumble-capable device it found, which on this hardware was Steam's virtual gamepad rather than the Legion controller.
- Turning on a per-game profile now actually applies it. The panel showed the game's values while the hardware kept the global ones; only turning the profile off used to push anything to the device.
- Settings are re-applied when the controller reconnects. Detection waits for the driver to attach instead of giving up because the device was not ready the instant it appeared.
- Per-game values no longer leak into your global profile. Rebooting while a game was running used to promote that game's settings to the new global default.
- Errors are shown instead of being swallowed. Failed changes, failed tests and failed update checks surface as notifications.
- Update downloads are verified again. Certificate checking had been disabled entirely; it now works properly, and downloads are restricted to GitHub, size-limited, and left owned by you rather than by root.

## [1.3.3] - 2026-05-23

### Fixed

- Update downloads respect the system language. The ZIP is saved to your actual XDG download directory - `Scaricati`, `Téléchargements` and so on - instead of a hardcoded `Downloads` folder.

## [1.3.2] - 2026-05-21

### Fixed

- The plugin failed to load after a fresh install. `package.json` is now included in the release ZIP; without it Decky Loader fell back to legacy script loading, which is incompatible with the ES module bundle, and showed a syntax error instead of the UI.

## [1.3.1] - 2026-05-20

### Added

- The per-game toggle shows the game name and the active profile tag (`MODE | LEVEL`) in green when the profile is enabled, matching the LeGoTDP style.

### Fixed

- No more spurious vibration. The plugin no longer triggers haptic pulses on load or on game launch and exit when the settings have not changed; an in-memory write cache skips sysfs writes that would produce duplicate driver pulses.

## [1.3.0] - 2026-05-18

### Added

- Per-game vibration profiles. Save separate intensity and mode settings per Steam game; the profile is applied automatically when the game launches.
- In-plugin update system. Check for updates and download the new version directly from the plugin menu; the downloaded ZIP is saved to `~/Downloads`, with install instructions shown in the UI.

## [1.2.0] - 2026-05-14

### Added

- Touchpad vibration control. An independent toggle and intensity slider for the touchpad haptic motor; changing the controller intensity no longer affects the touchpad.

### Changed

- Reset to defaults now resets all settings, including touchpad intensity (Medium) and touchpad enabled (on).
- The log prefix is `lego-vibe`, renamed from `lgo2-vibe`.

### Removed

- The left and right controller toggles. They only affected notification-type haptics rather than game force-feedback, which made them misleading.

### Fixed

- `rumble_notification` is reset on startup. Both handles are explicitly set to `true` at startup and on hotplug, clearing stale state left behind by the per-handle toggles in 1.1.0.

## [1.1.0] - 2026-05-13

### Added

- Vibration mode slider, with five patterns - FPS, Racing, Standard, SPG and RPG - applied globally to both handles.
- Driver-agnostic discovery: pyudev with two glob fallbacks, and no hardcoded driver path.
- Bundled pyudev 0.24.4, so the plugin works without pip or network access and is safe to sideload as a ZIP.
- A discovery method label, showing how the sysfs path was found - pyudev, glob-hid or glob-module.

### Fixed

- The interface no longer hangs indefinitely if the Python backend crashes on startup; initialisation times out after five seconds.
- Corrected the `global _discovery_method` declaration in the hotplug monitor.

## [1.0.0] - 2026-05-12

Initial release. Fork of [ally-vibe-control](https://github.com/piyush-tyagi-13/ally-vibe-control) by piyush-tyagi-13, ported to Lenovo Legion Go 2 hardware. Requires SteamOS 3.8 or newer for the `hid-lenovo-go` kernel driver, plus [Decky Loader](https://decky.xyz).

### Added

- Four vibration intensity levels: Off, Low, Medium and High.
- Per-handle toggles, enabling or disabling rumble on the left and right controller independently.
- Settings persist across reboots.
- Test vibration button, to feel the current setting.
- Driver status indicator, showing the active sysfs path.
- Reset to default (Medium) in one tap.

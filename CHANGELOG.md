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

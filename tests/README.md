# Tests

Plain `unittest`, no dependencies to install.

```bash
python -m unittest discover -s tests -v
```

`test_logic.py` needs nothing but Python and runs in CI. `test_device.py` needs
a Legion Go with `hid-lenovo-go` bound and **skips itself** everywhere else, so
the command above is correct in both places. The device tests fire real
vibrations - that is expected, not a failure.

Both files import the backend through `_harness.py`, which stubs the `decky`
and `settings` modules that only exist inside DeckyLoader, and points the
settings manager at a throwaway directory. Your real settings are never read
or written.

## Running against the device

Copy the repo across and run it there:

```bash
scp -r main.py updater.py plugin.json pyudev tests deck@<legion>:/tmp/lego-vibe-tests/
ssh deck@<legion> 'cd /tmp/lego-vibe-tests && sudo python3 -m unittest discover -s tests -v'
```

`sudo` is required: the sysfs attributes and `/dev/input/event*` are
root-only, exactly as they are for the plugin itself.

To exercise the copy DeckyLoader actually loaded rather than a fresh checkout,
point the harness at it:

```bash
LEGO_VIBE_PLUGIN_DIR=/home/deck/homebrew/plugins/LeGo-Vibe-Control \
  sudo -E python3 -m unittest discover -s tests -v
```

## What these cannot cover

- Anything in `src/index.tsx`. There is no frontend test setup; the UI is
  verified by hand on the device.
- The udev hotplug path. Reproducing it means a real unbind/rebind:
  `echo 0003:17EF:61EB.0013 | sudo tee /sys/bus/hid/drivers/hid-lenovo-go/unbind`
  then the same into `bind`, and watching
  `journalctl -u plugin_loader | grep lego-vibe`.
- Resume from suspend. `reapply()` is covered, but the thing that calls it is
  Steam's `RegisterForOnResumeFromSuspend` in the frontend - Decky has no
  backend resume hook - so actually sleeping the console is a manual check.
- `_uninstall()`. Removing the plugin is the only way to fire it; the check is
  that vibration is back on the driver defaults afterwards.
- The update download, which needs a newer release to exist on GitHub.

"""Backend tests that need no Legion Go attached. These run in CI."""
import asyncio
import glob
import json
import os
import ssl
import tempfile
import unittest

from _harness import (
    FIXTURE,
    GAME_WITHOUT_OVERRIDE,
    GAME_WITH_OVERRIDE,
    emitted,
    main,
    seed,
    updater,
)


class ProfileCoercion(unittest.TestCase):
    """A hand-edited or truncated settings.json must never crash an apply."""

    def test_junk_values_fall_back_to_defaults(self):
        coerced = main._coerce_profile({"level": "nonsense", "mode": None})
        self.assertEqual(coerced[main.PKEY_LEVEL], main.DEFAULT_PROFILE[main.PKEY_LEVEL])
        self.assertEqual(coerced[main.PKEY_MODE], main.DEFAULT_PROFILE[main.PKEY_MODE])

    def test_missing_and_non_dict_input(self):
        self.assertEqual(main._coerce_profile(None), main.DEFAULT_PROFILE)
        self.assertEqual(main._coerce_profile("not a dict"), main.DEFAULT_PROFILE)
        self.assertEqual(main._coerce_profile({}), main.DEFAULT_PROFILE)

    def test_levels_are_clamped(self):
        self.assertEqual(main._coerce_profile({"level": 99})[main.PKEY_LEVEL], 3)
        self.assertEqual(main._coerce_profile({"level": -5})[main.PKEY_LEVEL], 0)
        self.assertEqual(main._coerce_profile({"touchpadIntensity": 12})[main.PKEY_TP_INT], 3)

    def test_mode_has_no_upper_clamp(self):
        # The mode count comes from the driver, so _enum_at() clamps instead.
        self.assertEqual(main._coerce_profile({"mode": 40})[main.PKEY_MODE], 40)
        self.assertEqual(main._coerce_profile({"mode": -1})[main.PKEY_MODE], 0)

    def test_numeric_strings_are_accepted(self):
        self.assertEqual(main._coerce_profile({"level": "3"})[main.PKEY_LEVEL], 3)


def _explode() -> None:
    """Stand-in for a store that cannot be read or committed."""
    raise OSError("disk on fire")


class Migration(unittest.TestCase):
    def test_legacy_flat_keys_become_the_global_profile(self):
        seed({"intensity_level": 3, "rumble_mode": 2,
              "touchpad_intensity": 1, "touchpad_enabled": False})
        main._migrate()
        main.settings.read()
        self.assertEqual(main.settings.getSetting("schema_version"), main.CURRENT_SCHEMA)
        self.assertEqual(
            main._load_profiles()["0"]["settings"],
            {"level": 3, "mode": 2, "touchpadIntensity": 1, "touchpadEnabled": False},
        )

    def test_existing_global_profile_is_not_overwritten(self):
        seed({"intensity_level": 0, "rumble_mode": 0,
              "game_profiles": {"0": {"overwrite": False,
                                      "settings": {"level": 2, "mode": 1,
                                                   "touchpadIntensity": 2,
                                                   "touchpadEnabled": True}}}})
        main._migrate()
        kept = main._load_profiles()["0"]["settings"]
        self.assertEqual((kept["level"], kept["mode"]), (2, 1))

    def test_migration_is_idempotent(self):
        seed({"intensity_level": 3, "rumble_mode": 2})
        main._migrate()
        first = main._load_profiles()
        main._migrate()
        self.assertEqual(main._load_profiles(), first)

    def test_empty_settings_yield_defaults(self):
        seed({})
        main._migrate()
        self.assertEqual(main._active_values(), main.DEFAULT_PROFILE)

    def test_a_junk_schema_version_does_not_raise(self):
        # This runs from _migration(), where a raise kills the plugin before its
        # RPC socket exists - so a hand-edited store must not be able to do it.
        for junk in ("nonsense", None, [], {"a": 1}):
            with self.subTest(schema=junk):
                seed({"schema_version": junk, "intensity_level": 3})
                main._migrate()
                self.assertEqual(main._active_values()["level"], 3)

    def test_the_lifecycle_hook_runs_the_migration(self):
        # Decky runs _migration() to completion before it even schedules _main(),
        # which is the guarantee we want: no profile read can outrun it.
        seed({"intensity_level": 3, "rumble_mode": 2,
              "touchpad_intensity": 1, "touchpad_enabled": False})
        asyncio.run(main.Plugin()._migration())
        self.assertEqual(main._active_values()["level"], 3)

    def test_a_failed_migration_is_reported_not_raised(self):
        # The loader wraps start-up in a bare except that logs and exits, and it
        # never reaches setup_server() - so a raise here would strand the panel
        # retrying an is_ready() with nobody left to answer it.
        original, main._migrate = main._migrate, _explode
        try:
            asyncio.run(main.Plugin()._migration())
        finally:
            main._migrate = original
            self.addCleanup(setattr, main.Plugin, "_setup_error", None)
        self.assertIn("disk on fire", main.Plugin._setup_error or "")

    def test_a_recorded_migration_failure_survives_main(self):
        # _main() used to clear _setup_error on success, which would have wiped
        # exactly the message the user needs to see.
        main.Plugin._setup_error = "settings migration failed: disk on fire"
        self.addCleanup(setattr, main.Plugin, "_setup_error", None)
        original, main._apply_settings = main._apply_settings, lambda *a, **k: True
        try:
            asyncio.run(main.Plugin()._main())
        finally:
            main._apply_settings = original
            if main._monitor_task:
                main._monitor_task.cancel()
                main._monitor_task = None
        self.assertIn("disk on fire", main.Plugin._setup_error or "")


class ProfileResolution(unittest.TestCase):
    def setUp(self):
        seed(FIXTURE)

    def tearDown(self):
        main._active_app_id = main.DEFAULT_APP

    def test_game_profile_wins_when_flagged(self):
        main._active_app_id = GAME_WITH_OVERRIDE
        self.assertEqual(main._active_values()["mode"], 4)

    def test_game_profile_ignored_without_the_flag(self):
        main._active_app_id = GAME_WITHOUT_OVERRIDE
        self.assertEqual(main._active_values()["mode"], 1)

    def test_unknown_game_falls_back_to_global(self):
        main._active_app_id = "999999"
        self.assertEqual(main._active_values()["mode"], 1)

    def test_an_unsaved_edit_never_reaches_the_disk(self):
        # getSetting returns a live reference into the manager's own dict, and
        # every caller here coerces and mutates what it gets back. Without a
        # private copy any later commit flushes those uncommitted edits to disk
        # along with whatever it was actually saving.
        profiles = main._load_profiles()
        profiles[GAME_WITH_OVERRIDE]["settings"]["level"] = 0
        main.settings.setSetting("unrelated_key", True)
        main.settings.commit()
        with open(main.settings.path) as handle:
            stored = json.load(handle)["game_profiles"][GAME_WITH_OVERRIDE]
        self.assertEqual(stored["settings"]["level"], 3)

    def test_update_writes_to_the_resolved_profile(self):
        main._active_app_id = GAME_WITH_OVERRIDE
        main._update_active(main.PKEY_LEVEL, 1)
        profiles = main._load_profiles()
        self.assertEqual(profiles[GAME_WITH_OVERRIDE]["settings"]["level"], 1)
        # The global profile must be left alone - this leaking is what used to
        # promote a game's values to the global default after a reboot.
        self.assertEqual(profiles["0"]["settings"]["level"], 2)


class UpdateUrlValidation(unittest.TestCase):
    """The plugin runs as root, so the updater must not fetch arbitrary URLs."""

    def test_rejects_plain_http(self):
        with self.assertRaises(ValueError):
            updater.checked_url("http://github.com/x.zip")

    def test_rejects_non_http_schemes(self):
        for url in ("file:///etc/passwd", "ftp://github.com/x.zip"):
            with self.assertRaises(ValueError):
                updater.checked_url(url)

    def test_rejects_foreign_hosts(self):
        for url in ("https://evil.example.com/x.zip",
                    "https://github.com.evil.example.com/x.zip"):
            with self.assertRaises(ValueError):
                updater.checked_url(url)

    def test_accepts_known_github_hosts(self):
        for host in updater.ALLOWED_HOSTS:
            self.assertTrue(updater.checked_url(f"https://{host}/a.zip"))


class ShippedModuleNames(unittest.TestCase):
    """Before a plugin is imported, the loader aliases every one of its own
    submodules to a bare name:

        for key in [k for k in sys.modules if k.startswith("decky_loader.")]:
            sys.modules[key.replace("decky_loader.", "")] = sys.modules[key]

    `import x` consults sys.modules before sys.path, so a plugin file named
    after one of them never loads at all - the import silently hands back the
    loader's module instead. That is exactly how a shared `updater.py` shipped
    and killed both plugins on startup with a TypeError from the wrong Updater.
    """

    RESERVED = frozenset({
        "browser", "enums", "helpers", "injector", "loader",
        "main", "settings", "updater", "utilities", "wsrouter",
    })

    def test_no_shipped_module_is_shadowed_by_the_loader(self):
        shipped = {
            os.path.splitext(os.path.basename(path))[0]
            for path in glob.glob(os.path.join(main.PLUGIN_DIR, "*.py"))
        }
        # main.py is the one exemption: the loader loads it from an explicit
        # file location rather than by module name.
        self.assertEqual(sorted((shipped & self.RESERVED) - {"main"}), [])

    def test_the_packaged_payload_matches_what_we_import(self):
        # The zip is what reaches the device, so a rename that misses
        # scripts/package.mjs ships a plugin with no updater module at all.
        script = os.path.join(main.PLUGIN_DIR, "scripts", "package.mjs")
        if not os.path.isfile(script):
            self.skipTest("repo-only check; the deployed plugin ships no scripts/")
        with open(script) as handle:
            packaged = handle.read()
        self.assertIn('"lego_updater.py"', packaged)
        self.assertNotIn('"updater.py"', packaged)


class Versions(unittest.TestCase):
    def test_ordering(self):
        self.assertGreater(updater.version_tuple("1.5.0"), updater.version_tuple("1.4.9"))
        self.assertGreater(updater.version_tuple("1.10.0"), updater.version_tuple("1.9.0"))
        self.assertEqual(updater.version_tuple("1.5.0"), updater.version_tuple("1.5.0"))

    def test_non_numeric_tags_do_not_raise(self):
        self.assertEqual(updater.version_tuple("v1.5.0-beta"), (1, 5, 0))
        self.assertEqual(updater.version_tuple("nonsense"), ())

    def test_plugin_version_matches_the_manifest(self):
        with open(os.path.join(main.PLUGIN_DIR, "plugin.json")) as handle:
            self.assertEqual(main.updater.plugin_version(), json.load(handle)["version"])

    def test_the_loaders_version_wins_over_the_manifest(self):
        # PluginWrapper takes the version from package.json, so that is what
        # Decky's own plugin list shows. Preferring it here keeps the panel from
        # contradicting the loader if the two manifests ever drift.
        os.environ["DECKY_PLUGIN_VERSION"] = "9.9.9"
        try:
            self.assertEqual(main.updater.plugin_version(), "9.9.9")
        finally:
            del os.environ["DECKY_PLUGIN_VERSION"]

    def test_the_two_manifests_agree(self):
        # Nothing enforces this at runtime: the loader reads one file and the
        # packaging script reads the other.
        with open(os.path.join(main.PLUGIN_DIR, "plugin.json")) as handle:
            plugin_json = json.load(handle)["version"]
        with open(os.path.join(main.PLUGIN_DIR, "package.json")) as handle:
            package_json = json.load(handle)["version"]
        self.assertEqual(plugin_json, package_json)


class ReapplyAfterResume(unittest.IsolatedAsyncioTestCase):
    """The resume notification fires the moment the system wakes, several
    seconds before USB has finished re-enumerating. Measured on the device:
    resume at 20:04:19, controller back at 20:04:23 under a new sysfs path."""

    def setUp(self):
        seed(FIXTURE)
        self._apply, self._forget = main._apply_settings, main._forget_device
        self._wait, self._step = main._REAPPLY_WAIT_S, main._REAPPLY_STEP_S
        main._forget_device = lambda: None
        main._REAPPLY_STEP_S = 0.01
        self.addCleanup(setattr, main, "_apply_settings", self._apply)
        self.addCleanup(setattr, main, "_forget_device", self._forget)
        self.addCleanup(setattr, main, "_REAPPLY_WAIT_S", self._wait)
        self.addCleanup(setattr, main, "_REAPPLY_STEP_S", self._step)
        self.attempts = 0

    def _absent_until(self, n):
        def apply(values, sys_path=None, force=False):
            self.attempts += 1
            return self.attempts > n
        main._apply_settings = apply

    async def test_it_waits_for_the_controller_to_come_back(self):
        main._REAPPLY_WAIT_S = 5.0
        self._absent_until(3)
        result = await main.Plugin().reapply()
        self.assertTrue(result["success"])
        self.assertEqual(self.attempts, 4)

    async def test_a_device_already_present_is_applied_once(self):
        self._absent_until(0)
        self.assertTrue((await main.Plugin().reapply())["success"])
        self.assertEqual(self.attempts, 1, "no reason to retry a success")

    async def test_it_gives_up_rather_than_looping_forever(self):
        # A controller that never comes back must not leave a task spinning.
        main._REAPPLY_WAIT_S = 0.05
        self._absent_until(10_000)
        self.assertFalse((await main.Plugin().reapply())["success"])


class DeviceEvents(unittest.IsolatedAsyncioTestCase):
    """Hotplug happens with the Quick Access Menu shut more often than not, so
    the backend pushes the new state instead of waiting to be asked."""

    def setUp(self):
        seed(FIXTURE)
        emitted.clear()

    async def test_only_the_driver_status_is_pushed(self):
        # Deliberately not the settings. A hotplug re-applies the stored profile
        # without changing it, so that payload would tell the panel what it
        # already knows - and adopting one bumps the panel's edit counter, which
        # made it discard the reply to an edit the user was making at the time.
        await main._emit_device_status()
        self.assertEqual([name for name, _ in emitted], ["device"])

    async def test_the_status_payload_matches_the_rpc(self):
        # The panel adopts either interchangeably, so the two have to agree.
        await main._emit_device_status()
        self.assertEqual(dict(emitted)["device"][0],
                         await main.Plugin().get_driver_status())

    async def test_a_broken_push_does_not_escape(self):
        # Raised inside the hotplug handler this would kill the monitor task,
        # and with it every later reconnect.
        original, main._device_status = main._device_status, _explode
        try:
            await main._emit_device_status()
        finally:
            main._device_status = original
        self.assertEqual(emitted, [])


class DeviceIdParsing(unittest.TestCase):
    def test_parses_a_hid_directory_name(self):
        self.assertEqual(
            main._device_ids("/sys/bus/hid/drivers/hid-lenovo-go/0003:17EF:61EB.0013"),
            ("17ef", "61eb"),
        )

    def test_rejects_unrelated_names(self):
        for path in ("/sys/devices/whatever", "/sys/bus/hid/drivers/x/nonsense"):
            self.assertIsNone(main._device_ids(path))


class EnumDiscovery(unittest.TestCase):
    def test_reads_the_index_file_when_present(self):
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "rumble_mode_index"), "w") as handle:
                handle.write("fps racing standard spg rpg\n")
            self.assertEqual(
                main._read_enum(tmp, "rumble_mode", ["fallback"]),
                ["fps", "racing", "standard", "spg", "rpg"],
            )

    def test_falls_back_when_the_index_is_missing_or_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(main._read_enum(tmp, "rumble_mode", ["a", "b"]), ["a", "b"])
            with open(os.path.join(tmp, "rumble_mode_index"), "w") as handle:
                handle.write("\n")
            self.assertEqual(main._read_enum(tmp, "rumble_mode", ["a", "b"]), ["a", "b"])

    def test_enum_at_clamps_out_of_range_indexes(self):
        values = ["off", "low", "medium", "high"]
        self.assertEqual(main._enum_at(values, 0), "off")
        self.assertEqual(main._enum_at(values, 99), "high")
        self.assertEqual(main._enum_at(values, -3), "off")


class DownloadDirectory(unittest.TestCase):
    def test_reads_the_xdg_configuration(self):
        with tempfile.TemporaryDirectory() as home:
            config = os.path.join(home, ".config")
            os.makedirs(config)
            with open(os.path.join(config, "user-dirs.dirs"), "w") as handle:
                handle.write('XDG_DOWNLOAD_DIR="$HOME/Pobrane"\n')
            # The value is substituted verbatim, so the separator is the one
            # from the config file rather than the host's.
            self.assertEqual(updater.xdg_download_dir(home), f"{home}/Pobrane")

    def test_falls_back_to_downloads(self):
        with tempfile.TemporaryDirectory() as home:
            self.assertEqual(updater.xdg_download_dir(home),
                             os.path.join(home, "Downloads"))


class TlsContext(unittest.TestCase):
    def test_verification_stays_enabled_with_a_populated_store(self):
        context = main.updater.ssl_context()
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        # An empty store is the frozen-loader failure mode the fallback exists
        # to cover; if it is still empty here, nothing would ever verify.
        self.assertGreater(context.cert_store_stats()["x509_ca"], 0)


class DownloadCeiling(unittest.TestCase):
    """A truncated or endless download must not fill the device's disk."""

    class _Response:
        def __init__(self, total):
            self.remaining = total

        def read(self, size):
            chunk = b"x" * min(size, self.remaining)
            self.remaining -= len(chunk)
            return chunk

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def _updater_returning(self, total):
        u = updater.Updater(releases_url="https://api.github.com/x",
                            user_agent="test", log_prefix="[test]",
                            plugin_dir=main.PLUGIN_DIR, logger=main.decky.logger)
        u.open_url = lambda url, timeout: self._Response(total)
        return u

    def test_a_small_download_reports_its_size(self):
        u = self._updater_returning(1024)
        with tempfile.TemporaryFile() as out:
            self.assertEqual(u.download_to("https://github.com/a.zip", out, 10), 1024)

    def test_an_oversized_download_is_aborted(self):
        u = self._updater_returning(updater.MAX_DOWNLOAD_BYTES + 1)
        with tempfile.TemporaryFile() as out:
            with self.assertRaises(ValueError):
                u.download_to("https://github.com/a.zip", out, 10)


if __name__ == "__main__":
    unittest.main()

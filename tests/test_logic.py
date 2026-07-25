"""Backend tests that need no Legion Go attached. These run in CI."""
import json
import os
import ssl
import tempfile
import unittest

from _harness import (
    FIXTURE,
    GAME_WITHOUT_OVERRIDE,
    GAME_WITH_OVERRIDE,
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

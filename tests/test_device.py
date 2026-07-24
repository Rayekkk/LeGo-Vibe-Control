"""Tests that need a real Legion Go with hid-lenovo-go bound.

They skip themselves when the sysfs endpoint is absent, so the same
`python -m unittest discover tests` works on a build machine and on the device.
Several of these fire real vibrations, which is expected.
"""
import os
import unittest

from _harness import FIXTURE, GAME_WITH_OVERRIDE, has_device, main, seed

requires_device = unittest.skipUnless(
    has_device(), "no hid-lenovo-go device present"
)


@requires_device
class Discovery(unittest.TestCase):
    def test_device_is_found_and_identified(self):
        path = main._get_device_path()
        self.assertIsNotNone(path)
        self.assertEqual(main._device_ids(path), ("17ef", "61eb"))

    def test_capabilities_come_from_the_driver(self):
        caps = main._capabilities(main._get_device_path())
        self.assertEqual(caps["intensity"], ["off", "low", "medium", "high"])
        # Settles the old code comment that guessed the ABI's "standarg" was a
        # typo: the driver really does report "standard".
        self.assertIn("standard", caps["mode"])
        self.assertEqual(caps["mode"][0], "fps")


@requires_device
class ForceFeedbackSelection(unittest.TestCase):
    def test_event_nodes_are_sorted_numerically(self):
        names = [os.path.basename(n) for n in main._event_nodes()]
        # A lexicographic sort puts event16 before event2, which is how Steam's
        # virtual pad used to win over the real controller.
        self.assertLess(names.index("event2"), names.index("event16"))

    def test_the_matched_node_is_the_controller(self):
        node = main._find_ff_device()
        self.assertIsNotNone(node)
        self.assertEqual(main._node_ids(node), main._device_ids(main._get_device_path()))


@requires_device
class ApplyingSettings(unittest.TestCase):
    def setUp(self):
        seed(FIXTURE)

    def test_all_five_attributes_are_written(self):
        self.assertTrue(main._apply_settings(main._active_values()))
        self.assertEqual(len(main._attr_cache), 5)

    def test_repeated_applies_are_suppressed_by_the_cache(self):
        main._apply_settings(main._active_values())
        before = dict(main._attr_cache)
        main._apply_settings(main._active_values())
        self.assertEqual(main._attr_cache, before)

    def test_invalidating_the_cache_forces_a_rewrite(self):
        main._apply_settings(main._active_values())
        main._invalidate_cache()
        self.assertEqual(len(main._attr_cache), 0)
        self.assertTrue(main._apply_settings(main._active_values(), force=True))
        self.assertEqual(len(main._attr_cache), 5)


@requires_device
class PluginApi(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        seed(FIXTURE)
        self.plugin = main.Plugin()

    def tearDown(self):
        main._active_app_id = main.DEFAULT_APP

    async def test_reports_ready(self):
        self.assertTrue((await self.plugin.is_ready())["ready"])

    async def test_reapply_rewrites_everything(self):
        main._apply_settings(main._active_values())
        result = await self.plugin.reapply()
        self.assertTrue(result["success"])
        self.assertEqual(len(main._attr_cache), 5)

    async def test_enabling_a_game_profile_reaches_the_hardware(self):
        main._active_app_id = GAME_WITH_OVERRIDE
        main._invalidate_cache()
        result = await self.plugin.set_profile_overwrite(
            GAME_WITH_OVERRIDE, True, "Test Game")
        self.assertTrue(result["success"])
        self.assertEqual(result["settings"]["mode"], 4)

        device = main._get_device_path()
        # The panel used to show the game's values while the device kept the
        # global ones, because only *disabling* a profile applied anything.
        self.assertEqual(main._attr_cache[(device, "left_handle/rumble_mode")], "rpg")
        self.assertEqual(main._attr_cache[(device, "rumble_intensity")], "high")
        self.assertEqual(main._load_profiles()[GAME_WITH_OVERRIDE]["name"], "Test Game")

    async def test_disabling_a_game_profile_restores_the_global_one(self):
        main._active_app_id = GAME_WITH_OVERRIDE
        await self.plugin.set_profile_overwrite(GAME_WITH_OVERRIDE, True)
        await self.plugin.set_profile_overwrite(GAME_WITH_OVERRIDE, False)
        device = main._get_device_path()
        self.assertEqual(main._attr_cache[(device, "left_handle/rumble_mode")], "racing")

    async def test_profiles_can_be_deleted_except_the_global_one(self):
        self.assertTrue((await self.plugin.delete_game_profile(GAME_WITH_OVERRIDE))["success"])
        self.assertNotIn(GAME_WITH_OVERRIDE, main._load_profiles())
        self.assertFalse((await self.plugin.delete_game_profile("0"))["success"])


@requires_device
class Vibration(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        seed(FIXTURE)
        self.plugin = main.Plugin()

    async def test_a_short_test_effect_plays(self):
        # Regression guard: EVIOCRMFF takes the effect id by value, and passing
        # a packed buffer made every single call fail with EINVAL.
        self.assertTrue((await self.plugin.test_vibration(300))["success"])

    async def test_off_reports_a_useful_message(self):
        seed({"schema_version": 2,
              "game_profiles": {"0": {"overwrite": False,
                                      "settings": {"level": 0, "mode": 0,
                                                   "touchpadIntensity": 2,
                                                   "touchpadEnabled": True}}}})
        result = await self.plugin.test_vibration(200)
        self.assertFalse(result["success"])
        self.assertIn("Off", result["error"])

    async def test_concurrent_requests_do_not_stack(self):
        import asyncio
        first, second = await asyncio.gather(
            self.plugin.test_vibration(300), self.plugin.test_vibration(300))
        # Two overlapping effects combine into something resembling neither.
        self.assertNotEqual(first["success"], second["success"])


if __name__ == "__main__":
    unittest.main()

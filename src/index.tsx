// SPDX-License-Identifier: BSD-3-Clause AND MIT
// Copyright (c) 2026 Rayekkk
// Portions copyright (c) 2026 piyush-tyagi-13 and M4ttiA, MIT - see LICENSE.MIT
// https://github.com/Rayekkk/LeGo-Vibe-Control

import {
  ButtonItem,
  findModuleExport,
  PanelSection,
  PanelSectionRow,
  Router,
  SliderField,
  Spinner,
  staticClasses,
  ToggleField,
} from "@decky/ui";
import {
  addEventListener,
  callable,
  definePlugin,
  removeEventListener,
  toaster,
  useQuickAccessVisible,
} from "@decky/api";
import { useState, useEffect, useCallback, useRef } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface VibeSettings {
  level: number;
  mode: number;
  touchpadIntensity: number;
  touchpadEnabled: boolean;
}

interface SettingsResponse {
  settings: VibeSettings;
  app_id: string;
  profile_id: string;
  overwrite: boolean;
}

interface ApplyResponse {
  success: boolean;
  settings: VibeSettings;
  error?: string;
}

interface DriverStatus {
  found: boolean;
  paths: string[];
  method: string;
  ids: string;
}

interface ReadyState {
  ready: boolean;
  error: string;
}

interface UpdateInfo {
  current_version?: string;
  latest_version?: string;
  update_available?: boolean;
  download_url?: string;
  asset_name?: string;
  error?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_APP = "0";

const LEVEL_LABELS = ["Off", "Low", "Medium", "High"];
const LEVEL_NOTCHES = ["Off", "Low", "Med", "High"];

// Display names for the driver's raw mode values. Anything the driver
// reports that is not listed here is title-cased at render time, so a new
// kernel mode shows up without needing a plugin release.
const MODE_LABELS: Record<string, string> = {
  fps: "FPS",
  racing: "Racing",
  standard: "Standard",
  spg: "SPG",
  rpg: "RPG",
};
const MODE_NOTCHES: Record<string, string> = {
  fps: "FPS",
  racing: "Race",
  standard: "Std",
  spg: "SPG",
  rpg: "RPG",
};

const FALLBACK_MODES = ["fps", "racing", "standard", "spg", "rpg"];

const titleCase = (raw: string) => raw.charAt(0).toUpperCase() + raw.slice(1);
const modeLabel = (raw: string) => MODE_LABELS[raw] ?? titleCase(raw);
const modeNotch = (raw: string) => MODE_NOTCHES[raw] ?? titleCase(raw).slice(0, 5);

// ── Backend callables ─────────────────────────────────────────────────────────

const isReady = callable<[], ReadyState>("is_ready");
const getSettings = callable<[], SettingsResponse>("get_settings");
const setActiveApp = callable<[string], SettingsResponse & { success: boolean; changed: boolean }>("set_active_app");

const setIntensity = callable<[number], ApplyResponse>("set_intensity");
const setRumbleMode = callable<[number], ApplyResponse>("set_rumble_mode");
const setTouchpadIntensity = callable<[number], ApplyResponse>("set_touchpad_intensity");
const setTouchpadEnabled = callable<[boolean], ApplyResponse>("set_touchpad_enabled");
const resetToDefault = callable<[], ApplyResponse>("reset_to_default");
const reapply = callable<[], ApplyResponse>("reapply");

const setProfileOverwrite = callable<[string, boolean, string], ApplyResponse & { overwrite: boolean }>("set_profile_overwrite");

const getDriverStatus = callable<[], DriverStatus>("get_driver_status");
const getCapabilities = callable<[], { intensity: string[]; mode: string[]; tp_intensity: string[] }>("get_capabilities");
const getVersion = callable<[], { version: string }>("get_version");
const testVibration = callable<[number], { success: boolean; error?: string }>("test_vibration");
const checkForUpdates = callable<[], UpdateInfo>("check_for_updates");
const performUpdate = callable<[string, string], { success: boolean; path?: string; error?: string }>("perform_update");

// ── Toasts ────────────────────────────────────────────────────────────────────

const notify = (title: string, body: string) => {
  try {
    toaster.toast({ title, body, duration: 4000 });
  } catch {
    console.error(`[lego-vibe] ${title}: ${body}`);
  }
};

const notifyFailure = (title: string, err: unknown) => {
  const body = err instanceof Error ? err.message : String(err ?? "Unknown error");
  console.error(`[lego-vibe] ${title}`, err);
  notify(title, body);
};

/** Report a backend result that carries its own error string. */
const checkResult = (title: string, res: { success: boolean; error?: string }) => {
  if (!res.success) notify(title, res.error ?? "The driver rejected the change");
  return res.success;
};

// ── Resume from suspend ───────────────────────────────────────────────────────

/**
 * Subscribe to resume-from-suspend. Returns an unsubscribe function, or null
 * when the client offers no way to hear about it.
 *
 * `SteamClient.System.RegisterForOnResumeFromSuspend` was removed from the
 * Steam client in the September 2025 beta. Optional chaining meant calling it
 * silently did nothing - confirmed on the device, where two suspend cycles
 * produced no reapply at all. Nothing looked broken only because the
 * controller happened to re-enumerate and the hotplug monitor caught it; on a
 * resume where it does not, the write cache still believes our values are in
 * place and the controller quietly keeps the firmware defaults.
 *
 * The replacement lives on a SleepManager module, reachable either as a global
 * or through the webpack exports; the legacy call stays for older clients.
 */
function onResumeFromSuspend(handler: () => void): (() => void) | null {
  const asUnsub = (reg: any): (() => void) | null => {
    if (typeof reg === "function") return reg;
    if (typeof reg?.unregister === "function") return () => reg.unregister();
    return null;
  };
  const isSleepManager = (e: any) =>
    !!e && typeof e === "object" &&
    (typeof e.RegisterForNotifyResumeFromSuspend === "function" ||
      typeof e.NotifyResumeFromSuspend === "function");

  try {
    const mgr = (window as any).SleepManager ?? findModuleExport(isSleepManager);
    const unsub = asUnsub(mgr?.RegisterForNotifyResumeFromSuspend?.(handler));
    if (unsub) return unsub;
  } catch (e) {
    console.warn("[lego-vibe] SleepManager lookup failed", e);
  }

  try {
    const unsub = asUnsub(
      (window as any).SteamClient?.System?.RegisterForOnResumeFromSuspend?.(handler));
    if (unsub) return unsub;
  } catch (e) {
    console.warn("[lego-vibe] legacy resume registration failed", e);
  }

  // Said out loud rather than swallowed: this going quiet again is exactly how
  // the previous registration rotted unnoticed.
  console.warn("[lego-vibe] no resume-from-suspend notification available; "
    + "settings will only be restored if the controller re-enumerates");
  return null;
}

// ── Running app watcher ───────────────────────────────────────────────────────

type SettingsListener = (res: SettingsResponse) => void;

/**
 * Tracks the foreground game and tells the backend about it, so the backend
 * can resolve per-game profiles on its own - including for hotplug and
 * resume, which never go through the UI.
 *
 * This used to poll every 100 ms. It now reacts to Steam's app lifetime
 * notifications, with a slow interval purely as a safety net because
 * Router.MainRunningApp can change without a lifetime event firing.
 */
class AppWatcher {
  private static listeners: SettingsListener[] = [];
  private static currentId = DEFAULT_APP;
  private static timer: ReturnType<typeof setInterval> | undefined;
  private static unsubs: Array<() => void> = [];
  private static started = false;
  private static busy = false;

  static activeId(): string {
    try {
      return String((Router as any)?.MainRunningApp?.appid || DEFAULT_APP);
    } catch {
      return DEFAULT_APP;
    }
  }

  static displayName(): string {
    try {
      const app = (Router as any)?.MainRunningApp;
      return app?.appid ? (app.display_name || `App ${app.appid}`) : "";
    } catch {
      return "";
    }
  }

  static listen(fn: SettingsListener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((f) => f !== fn);
    };
  }

  static start() {
    if (this.started) return;
    this.started = true;
    this.currentId = this.activeId();

    // Push the starting state so the backend is never out of sync with us.
    void setActiveApp(this.currentId).catch((e) =>
      console.error("[lego-vibe] initial setActiveApp failed", e),
    );

    const steam = (window as any).SteamClient;

    try {
      const reg = steam?.GameSessions?.RegisterForAppLifetimeNotifications?.(() => {
        // Router.MainRunningApp lags the notification slightly.
        setTimeout(() => void this.check(), 300);
      });
      if (reg?.unregister) this.unsubs.push(() => reg.unregister());
    } catch (e) {
      console.warn("[lego-vibe] app lifetime notifications unavailable", e);
    }

    // The controller comes back at its firmware defaults, and the backend's
    // write cache would otherwise skip the rewrite.
    const offResume = onResumeFromSuspend(() => {
      void reapply()
        .then((res) => {
          if (!res.success) console.warn("[lego-vibe] reapply after resume failed");
        })
        .catch((e) => console.error("[lego-vibe] reapply after resume threw", e));
    });
    if (offResume) this.unsubs.push(offResume);

    this.timer = setInterval(() => void this.check(), 2000);
  }

  static stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const off of this.unsubs) {
      try {
        off();
      } catch {
        /* the subscription may already be gone */
      }
    }
    this.unsubs = [];
    this.listeners = [];
    this.currentId = DEFAULT_APP;
    this.started = false;
  }

  private static async check() {
    if (this.busy) return;
    const id = this.activeId();
    if (id === this.currentId) return;
    this.busy = true;
    try {
      const res = await setActiveApp(id);
      // Committed only once the backend has it. Recording the id before the
      // call meant a single failed RPC - the loader restarting, say - left
      // every later tick thinking there was nothing to send, so the hardware
      // kept the previous game's profile for the rest of the session.
      this.currentId = id;
      this.listeners.forEach((fn) => fn(res));
    } catch (e) {
      console.error("[lego-vibe] setActiveApp failed, will retry", e);
    } finally {
      this.busy = false;
    }
  }
}

// ── Styles - Steam theme variables with hardcoded fallbacks ───────────────────

const OK_COLOR = "var(--gpColor-Green, #4ade80)";
const BAD_COLOR = "var(--gpColor-Red, #f87171)";
const WARN_COLOR = "var(--gpColor-Yellow, #fbbf24)";
const DIM_COLOR = "var(--gpColor-TextMuted, rgba(255,255,255,0.5))";

const styles = {
  container: { display: "flex", flexDirection: "column" as const, gap: "4px" },
  statusRow: { display: "flex", alignItems: "center", gap: "8px", padding: "4px 0" },
  dot: (ok: boolean) => ({
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    backgroundColor: ok ? OK_COLOR : BAD_COLOR,
    flexShrink: 0,
  }),
  statusText: (ok: boolean) => ({
    fontSize: "11px",
    color: ok ? OK_COLOR : BAD_COLOR,
    fontFamily: "monospace",
    wordBreak: "break-all" as const,
  }),
  valueTag: {
    fontSize: "13px",
    fontWeight: "bold",
    color: "var(--gpColor-White, #fff)",
    background: "rgba(255,255,255,0.1)",
    borderRadius: "4px",
    padding: "1px 6px",
    fontFamily: "monospace",
  },
  infoBox: {
    background: "rgba(251,191,36,0.15)",
    border: "1px solid rgba(251,191,36,0.4)",
    borderRadius: "6px",
    padding: "8px 10px",
    fontSize: "11px",
    color: WARN_COLOR,
    lineHeight: "1.5",
    marginTop: "4px",
  },
  errorBox: {
    background: "rgba(248,113,113,0.1)",
    border: "1px solid rgba(248,113,113,0.4)",
    borderRadius: "6px",
    padding: "8px 10px",
    fontSize: "11px",
    color: BAD_COLOR,
    lineHeight: "1.5",
    marginTop: "4px",
  },
  methodText: {
    fontSize: "10px",
    color: DIM_COLOR,
    fontFamily: "monospace",
    marginTop: "2px",
  },
  profileTag: {
    fontSize: "11px",
    fontWeight: "bold",
    color: "var(--gpColor-White, #fff)",
    background: "rgba(74,222,128,0.25)",
    border: "1px solid rgba(74,222,128,0.5)",
    borderRadius: "3px",
    padding: "0px 5px",
    fontFamily: "monospace",
  },
};

// ── Main component ────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: VibeSettings = {
  level: 2,
  mode: 0,
  touchpadIntensity: 2,
  touchpadEnabled: true,
};

const LGoVibeControl = () => {
  const [settings, setSettings] = useState<VibeSettings>(DEFAULT_SETTINGS);
  const [modes, setModes] = useState<string[]>(FALLBACK_MODES);
  const [driver, setDriver] = useState<DriverStatus | null>(null);
  const [version, setVersion] = useState("");

  const [appId, setAppId] = useState(DEFAULT_APP);
  const [gameName, setGameName] = useState("");
  const [perGameOn, setPerGameOn] = useState(false);

  const [loading, setLoading] = useState(true);
  const [setupErr, setSetupErr] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [testing, setTesting] = useState(false);

  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadPath, setDownloadPath] = useState<string | null>(null);

  const visible = useQuickAccessVisible();

  // Coalesces a slider drag into a single backend call. The UI still moves
  // immediately; only the RPC and its disk commit are deferred.
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const debounce = useCallback((key: string, fn: () => void, delay = 150) => {
    const pending = timers.current[key];
    if (pending) clearTimeout(pending);
    timers.current[key] = setTimeout(fn, delay);
  }, []);

  useEffect(
    () => () => {
      for (const t of Object.values(timers.current)) clearTimeout(t);
    },
    [],
  );

  // Bumped by every optimistic edit. A reply may only overwrite the UI while it
  // is still the newest thing that happened, otherwise a slow sysfs write snaps
  // the slider back to a value the user has already moved off.
  const editSeq = useRef(0);

  const adoptResponse = useCallback((res: SettingsResponse) => {
    // Counts as an edit: switching game replaces the whole profile, and a field
    // reply still in flight from the previous one must not undo that.
    editSeq.current += 1;
    setSettings(res.settings);
    setAppId(res.app_id);
    setPerGameOn(res.overwrite);
    setGameName(AppWatcher.displayName());
  }, []);

  const refreshDriver = useCallback(async () => {
    try {
      setDriver(await getDriverStatus());
    } catch (e) {
      console.error("[lego-vibe] getDriverStatus failed", e);
    }
  }, []);

  // Initial load. Gated on is_ready so a backend that failed to start shows the
  // reason instead of sliders that silently do nothing.
  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const state = await isReady();
        if (!active) return;
        if (state.error) {
          setSetupErr(state.error);
          setLoading(false);
          return;
        }
        if (!state.ready) {
          if (active) setTimeout(check, 1000);
          return;
        }
        const [current, status, caps, ver] = await Promise.all([
          getSettings(),
          getDriverStatus(),
          getCapabilities().catch(() => ({ mode: FALLBACK_MODES } as any)),
          getVersion().catch(() => ({ version: "" })),
        ]);
        if (!active) return;
        adoptResponse(current);
        setDriver(status);
        setModes(caps?.mode?.length ? caps.mode : FALLBACK_MODES);
        setVersion(ver.version ?? "");
        setLoading(false);
      } catch (e) {
        if (!active) return;
        notifyFailure("LeGo Vibe Control failed to load", e);
        setLoading(false);
      }
    };
    void check();
    return () => { active = false; };
  }, [adoptResponse]);

  // Hotplug pushes the driver status from the backend, so the dot is right even
  // while the panel is shut. Registered unconditionally: a controller is plugged
  // in with the Quick Access Menu closed far more often than with it open, and
  // adopting the state on arrival beats discovering it on the next open.
  //
  // Only the status. A hotplug re-applies the stored profile without changing
  // it, so a settings payload would carry nothing new - and feeding one to
  // adoptResponse bumps editSeq, which would make the panel throw away the
  // reply to an edit the user was making at that moment.
  useEffect(() => {
    const onDevice = (status: DriverStatus) => setDriver(status);
    addEventListener<[DriverStatus]>("device", onDevice);
    return () => removeEventListener<[DriverStatus]>("device", onDevice);
  }, []);

  // Still re-checked on open, as the backstop for the cases no event covers:
  // without pyudev there is no hotplug monitor at all, and a plugin reload
  // starts with whatever the hardware already is.
  useEffect(() => {
    if (visible && !loading) void refreshDriver();
  }, [visible, loading, refreshDriver]);

  // Game changes are applied by the backend; just adopt what it reports.
  useEffect(() => AppWatcher.listen(adoptResponse), [adoptResponse]);

  // Handlers

  const applyField = useCallback(
    async (key: string, optimistic: Partial<VibeSettings>, call: () => Promise<ApplyResponse>) => {
      const seq = ++editSeq.current;
      setSettings((prev) => ({ ...prev, ...optimistic }));
      debounce(key, () => {
        setApplying(true);
        call()
          .then((res) => {
            checkResult("Could not apply setting", res);
            if (res.settings && seq === editSeq.current) setSettings(res.settings);
          })
          .catch((e) => {
            notifyFailure("Could not apply setting", e);
            // Only resync when nothing newer is pending; the newer edit's own
            // reply is the one that should decide what the panel shows.
            if (seq === editSeq.current) {
              void getSettings().then(adoptResponse).catch(() => undefined);
            }
          })
          .finally(() => setApplying(false));
      });
    },
    [debounce, adoptResponse],
  );

  const handleLevel = useCallback(
    (val: number) => void applyField("level", { level: val }, () => setIntensity(val)),
    [applyField],
  );

  const handleMode = useCallback(
    // No sample is played here on purpose: the controller firmware already
    // demonstrates the new pattern. Adding our own put a second rumble on
    // top of it, which is why the same mode felt different every time.
    (val: number) => void applyField("mode", { mode: val }, () => setRumbleMode(val)),
    [applyField],
  );

  const handleTpIntensity = useCallback(
    (val: number) =>
      void applyField("tpIntensity", { touchpadIntensity: val }, () => setTouchpadIntensity(val)),
    [applyField],
  );

  const handleTpToggle = useCallback(
    (val: boolean) =>
      void applyField("tpEnabled", { touchpadEnabled: val }, () => setTouchpadEnabled(val)),
    [applyField],
  );

  const handleReset = useCallback(async () => {
    setApplying(true);
    try {
      const res = await resetToDefault();
      if (checkResult("Reset failed", res)) {
        setSettings(res.settings);
        notify("LeGo Vibe Control", "Settings restored to defaults");
      }
    } catch (e) {
      notifyFailure("Reset failed", e);
    } finally {
      setApplying(false);
    }
  }, []);

  const handleTest = useCallback(async () => {
    setTesting(true);
    try {
      const res = await testVibration(500);
      checkResult("Test vibration failed", res);
    } catch (e) {
      notifyFailure("Test vibration failed", e);
    } finally {
      setTesting(false);
    }
  }, []);

  const handlePerGameToggle = useCallback(
    async (val: boolean) => {
      setPerGameOn(val);
      setApplying(true);
      try {
        // The backend applies the resolved profile for us, which is what the
        // old frontend skipped when *enabling* a profile - the UI showed the
        // game's values while the hardware kept the global ones.
        const res = await setProfileOverwrite(appId, val, AppWatcher.displayName());
        if (checkResult("Could not switch profile", res)) {
          setSettings(res.settings);
        } else {
          setPerGameOn(!val);
        }
      } catch (e) {
        setPerGameOn(!val);
        notifyFailure("Could not switch profile", e);
      } finally {
        setApplying(false);
      }
    },
    [appId],
  );

  const handleCheckUpdate = useCallback(async () => {
    setChecking(true);
    setUpdateInfo(null);
    setDownloadPath(null);
    try {
      setUpdateInfo(await checkForUpdates());
    } catch (e) {
      notifyFailure("Update check failed", e);
      setUpdateInfo({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setChecking(false);
    }
  }, []);

  const handleDownloadUpdate = useCallback(async () => {
    if (!updateInfo?.download_url || !updateInfo?.asset_name) return;
    setDownloading(true);
    try {
      const res = await performUpdate(updateInfo.download_url, updateInfo.asset_name);
      if (res.success && res.path) setDownloadPath(res.path);
      else {
        setUpdateInfo({ ...updateInfo, error: res.error });
        notify("Download failed", res.error ?? "Unknown error");
      }
    } catch (e) {
      notifyFailure("Download failed", e);
    } finally {
      setDownloading(false);
    }
  }, [updateInfo]);

  // Render

  if (setupErr) {
    return (
      <PanelSection title="Setup Error">
        <PanelSectionRow>
          <div style={styles.errorBox}>{setupErr}</div>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  if (loading) {
    return (
      <PanelSection title="Initializing...">
        <PanelSectionRow>
          <Spinner />
        </PanelSectionRow>
      </PanelSection>
    );
  }

  const driverFound = driver?.found ?? false;
  const gameRunning = appId !== DEFAULT_APP;
  const modeName = modes[settings.mode] ?? FALLBACK_MODES[0];

  return (
    <div style={styles.container}>
      <PanelSection title="Driver Status">
        <PanelSectionRow>
          <div style={styles.statusRow}>
            <div style={styles.dot(driverFound)} />
            <div>
              <span style={styles.statusText(driverFound)}>
                {driverFound
                  ? driver?.paths[0] ?? "hid-lenovo-go found"
                  : "hid-lenovo-go driver not found"}
              </span>
              {driverFound && driver?.method && (
                <div style={styles.methodText}>
                  via: {driver.method}
                  {driver.ids ? ` (${driver.ids})` : ""}
                </div>
              )}
            </div>
          </div>
        </PanelSectionRow>
        {!driverFound && (
          <PanelSectionRow>
            <div style={styles.infoBox}>
              The hid-lenovo-go sysfs endpoint was not detected. Requires SteamOS 3.8+ / Kernel
              6.18+ with the hid-lenovo-go module loaded on Legion Go hardware.
            </div>
          </PanelSectionRow>
        )}
      </PanelSection>

      <PanelSection title="Per-Game Profile">
        <PanelSectionRow>
          <ToggleField
            label="Per Game Profile"
            description={
              gameRunning ? (
                perGameOn ? (
                  <span style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                    <span>{gameName}</span>
                    <span>
                      <span style={styles.profileTag}>
                        {modeLabel(modeName)} | {LEVEL_LABELS[settings.level]}
                      </span>
                    </span>
                  </span>
                ) : (
                  gameName
                )
              ) : (
                "Launch a game to use per-game profiles."
              )
            }
            checked={perGameOn && gameRunning}
            disabled={!gameRunning || applying}
            onChange={handlePerGameToggle}
          />
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Vibration">
        <PanelSectionRow>
          <SliderField
            label="Intensity"
            description={
              <span>
                Level: <span style={styles.valueTag}>{LEVEL_LABELS[settings.level]}</span>
              </span>
            }
            value={settings.level}
            min={0}
            max={3}
            step={1}
            notchCount={4}
            notchLabels={LEVEL_NOTCHES.map((label, notchIndex) => ({ notchIndex, label }))}
            onChange={handleLevel}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <SliderField
            label="Mode"
            description={
              <span>
                Mode: <span style={styles.valueTag}>{modeLabel(modeName)}</span>
              </span>
            }
            value={settings.mode}
            min={0}
            max={Math.max(0, modes.length - 1)}
            step={1}
            notchCount={modes.length}
            notchLabels={modes.map((raw, notchIndex) => ({ notchIndex, label: modeNotch(raw) }))}
            onChange={handleMode}
          />
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Touchpad">
        <PanelSectionRow>
          <ToggleField
            label="Touchpad vibration"
            description="Enable vibration on touchpad"
            checked={settings.touchpadEnabled}
            onChange={handleTpToggle}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <SliderField
            label="Touchpad intensity"
            description={
              <span>
                Level:{" "}
                <span style={styles.valueTag}>{LEVEL_LABELS[settings.touchpadIntensity]}</span>
              </span>
            }
            value={settings.touchpadIntensity}
            min={0}
            max={3}
            step={1}
            notchCount={4}
            notchLabels={LEVEL_NOTCHES.map((label, notchIndex) => ({ notchIndex, label }))}
            disabled={!settings.touchpadEnabled}
            onChange={handleTpIntensity}
          />
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Actions">
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            description="Tests current intensity and mode."
            onClick={handleTest}
            disabled={applying || testing}
          >
            {testing ? "Vibrating..." : "Test Vibration (0.5s)"}
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={handleReset} disabled={applying || testing}>
            Reset to defaults
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Updates">
        <PanelSectionRow>
          <div style={{ fontSize: "12px", color: DIM_COLOR }}>
            Installed:{" "}
            <span style={styles.valueTag}>v{updateInfo?.current_version ?? version ?? "?"}</span>
            {updateInfo?.latest_version && !updateInfo.error && (
              <span>
                {" "}
                Latest: <span style={styles.valueTag}>v{updateInfo.latest_version}</span>
              </span>
            )}
          </div>
        </PanelSectionRow>
        {updateInfo?.error && (
          <PanelSectionRow>
            <div style={styles.errorBox}>{updateInfo.error}</div>
          </PanelSectionRow>
        )}
        {updateInfo && !updateInfo.error && !updateInfo.update_available && !downloadPath && (
          <PanelSectionRow>
            <div style={{ fontSize: "12px", color: OK_COLOR }}>Up to date</div>
          </PanelSectionRow>
        )}
        {updateInfo?.update_available && !downloadPath && (
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={handleDownloadUpdate} disabled={downloading}>
              {downloading ? "Downloading..." : `Download v${updateInfo.latest_version}`}
            </ButtonItem>
          </PanelSectionRow>
        )}
        {downloadPath && (
          <PanelSectionRow>
            <div style={styles.infoBox}>
              Downloaded to{" "}
              <span style={{ fontFamily: "monospace", wordBreak: "break-all" }}>
                {downloadPath}
              </span>
              <br />
              <br />
              To install: Decky - Developer - Uninstall LeGo Vibe Control - Install Plugin from ZIP
              - select the file.
            </div>
          </PanelSectionRow>
        )}
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={handleCheckUpdate} disabled={checking || downloading}>
            {checking ? "Checking..." : "Check for updates"}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Notes">
        <PanelSectionRow>
          <div style={styles.infoBox}>
            Intensity levels: Off, Low, Medium, High. Mode selects the vibration pattern, applied to
            both handles. Settings persist across reboots and are re-applied after sleep or a
            controller reconnect. Per-game profiles auto-apply when a game with a saved profile
            starts.
          </div>
        </PanelSectionRow>
      </PanelSection>
    </div>
  );
};

// ── Plugin entry point ────────────────────────────────────────────────────────

export default definePlugin(() => {
  // Started unconditionally: the old code registered the game listener inside
  // an init().then(), so a single failed load disabled per-game profiles for
  // the rest of the session.
  AppWatcher.start();

  return {
    name: "LeGo Vibe Control",
    titleView: <div className={staticClasses.Title}>LeGo Vibe Control</div>,
    content: <LGoVibeControl />,
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        style={{ width: "1em", height: "1em" }}
      >
        <path d="M0 15h2V9H0v6zm3 2h2V7H3v10zm19-8v6h2V9h-2zm-3 8h2V7h-2v10zm-7-1c2.76 0 5-2.24 5-5s-2.24-5-5-5-5 2.24-5 5 2.24 5 5 5zm0-8c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3z" />
      </svg>
    ),
    onDismount() {
      AppWatcher.stop();
    },
  };
});

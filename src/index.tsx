import {
  ButtonItem,
  PanelSection,
  PanelSectionRow,
  Router,
  SliderField,
  ToggleField,
} from "@decky/ui";
import { callable, definePlugin } from "@decky/api";
import { useState, useEffect, useCallback } from "react";

// Types

interface VibeSettings {
  level: number;
  mode: number;
  touchpadIntensity: number;
  touchpadEnabled: boolean;
}

interface PerAppEntry {
  overwrite: boolean;
  settings: VibeSettings;
}

type GameProfiles = Record<string, PerAppEntry>;

// Constants

const DEFAULT_APP = "0";
const LEVEL_LABELS = ["Off", "Low", "Medium", "High"];
const MODE_LABELS  = ["FPS", "Racing", "Standard", "SPG", "RPG"];

// Backend callables

const getSettings = callable<[], {
  level: number; mode: number;
  touchpad_intensity: number; touchpad_enabled: boolean;
}>("get_settings");

const setIntensity       = callable<[number],  { success: boolean; level: number }>("set_intensity");
const setRumbleMode      = callable<[number],  { success: boolean; mode: number }>("set_rumble_mode");
const setTouchpadIntensity = callable<[number],  { success: boolean; level: number }>("set_touchpad_intensity");
const setTouchpadEnabled = callable<[boolean], { success: boolean; enabled: boolean }>("set_touchpad_enabled");
const resetToDefault     = callable<[], { success: boolean; level: number; mode: number; touchpad_intensity: number; touchpad_enabled: boolean }>("reset_to_default");
const getDriverStatus    = callable<[], { found: boolean; paths: string[]; method: string }>("get_driver_status");
const testVibration      = callable<[number],  { success: boolean; error?: string }>("test_vibration");
const checkForUpdates    = callable<[], { current_version?: string; latest_version?: string; update_available?: boolean; download_url?: string; asset_name?: string; error?: string }>("check_for_updates");
const performUpdate      = callable<[string, string], { success: boolean; path?: string; error?: string }>("perform_update");

const getGameProfiles = callable<[], GameProfiles>("get_game_profiles");
const setGameProfiles = callable<[GameProfiles], { success: boolean }>("set_game_profiles");

// Running Apps polling

type AppChangeHandler = () => void;

class RunningApps {
  private static listeners: AppChangeHandler[] = [];
  private static lastAppId = DEFAULT_APP;
  private static intervalId: ReturnType<typeof setInterval> | undefined;

  static register() {
    if (!this.intervalId) {
      this.intervalId = setInterval(() => this.poll(), 100);
    }
  }

  static unregister() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.listeners = [];
  }

  private static poll() {
    const cur = this.active();
    if (cur !== this.lastAppId) {
      this.lastAppId = cur;
      this.listeners.forEach((fn) => fn());
    }
  }

  static listen(fn: AppChangeHandler): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((f) => f !== fn);
    };
  }

  static active(): string {
    return String((Router as any)?.MainRunningApp?.appid || 0);
  }

  static displayName(): string {
    const app = (Router as any)?.MainRunningApp;
    return (app && app.appid) ? (app.display_name || `App ${app.appid}`) : "";
  }
}

// SettingsManager

class SettingsManager {
  static perApp: GameProfiles = {};
  private static listeners: Array<() => void> = [];

  static onChange(fn: () => void) {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter((f) => f !== fn); };
  }

  static notify() {
    this.listeners.forEach((fn) => fn());
  }

  private static _initPromise: Promise<void> | null = null;

  // Load profiles from backend — deduplicated so concurrent calls share one fetch
  static init(): Promise<void> {
    if (!this._initPromise) {
      this._initPromise = (async () => {
        const [s, gp] = await Promise.all([getSettings(), getGameProfiles()]);
        this.perApp = gp || {};
        if (!this.perApp[DEFAULT_APP]) {
          this.perApp[DEFAULT_APP] = {
            overwrite: false,
            settings: {
              level: s.level,
              mode: s.mode ?? 0,
              touchpadIntensity: s.touchpad_intensity ?? 2,
              touchpadEnabled: s.touchpad_enabled ?? true,
            },
          };
        }
      })().catch((e) => {
        this._initPromise = null;
        throw e;
      });
    }
    return this._initPromise;
  }

  // Save all profiles to backend
  private static persist() {
    void setGameProfiles({ ...this.perApp });
  }

  // Get the resolved appId
  static resolvedAppId(): string {
    const appId = RunningApps.active();
    if (appId !== DEFAULT_APP && this.perApp[appId]?.overwrite) {
      return appId;
    }
    return DEFAULT_APP;
  }

  // Get the currently active settings
  static current(): VibeSettings {
    const entry = this.perApp[this.resolvedAppId()];
    return entry ? { ...entry.settings } : { level: 2, mode: 0, touchpadIntensity: 2, touchpadEnabled: true };
  }

  static isOverwrite(): boolean {
    const appId = RunningApps.active();
    return appId !== DEFAULT_APP && (this.perApp[appId]?.overwrite ?? false);
  }

  // Toggle per-game override on/off for the current running game
  static setOverwrite(val: boolean) {
    const appId = RunningApps.active();
    if (appId === DEFAULT_APP) return;
    if (val) {
      // Enabling: create profile from current settings
      if (!this.perApp[appId]) {
        this.perApp[appId] = { overwrite: true, settings: { ...this.current() } };
      } else {
        this.perApp[appId].overwrite = true;
      }
    } else {
      // Disabling: remove override flag
      if (this.perApp[appId]) {
        this.perApp[appId].overwrite = false;
      }
    }
    this.persist();
  }

  // Update a setting in the resolved profile
  static set<K extends keyof VibeSettings>(key: K, value: VibeSettings[K]) {
    const appId = this.resolvedAppId();
    if (!this.perApp[appId]) {
      this.perApp[appId] = { overwrite: false, settings: { ...this.current() } };
    }
    this.perApp[appId].settings[key] = value;
    this.persist();
  }

  static setAll(s: VibeSettings) {
    const appId = this.resolvedAppId();
    if (!this.perApp[appId]) {
      this.perApp[appId] = { overwrite: false, settings: { ...s } };
    } else {
      this.perApp[appId].settings = { ...s };
    }
    this.persist();
  }

  static async applyToHW(prev: VibeSettings | null) {
    const s = this.current();
    if (!prev || prev.level !== s.level) {
      await setIntensity(s.level);
    }
    if (!prev || prev.mode !== s.mode) {
      await setRumbleMode(s.mode);
    }
    if (!prev || prev.touchpadIntensity !== s.touchpadIntensity) {
      await setTouchpadIntensity(s.touchpadIntensity);
    }
    if (!prev || prev.touchpadEnabled !== s.touchpadEnabled) {
      await setTouchpadEnabled(s.touchpadEnabled);
    }
  }
}

// ------------------------------------------------------------------ //
// Styles
// ------------------------------------------------------------------ //

const styles = {
  container: { display: "flex", flexDirection: "column" as const, gap: "4px" },
  statusRow: { display: "flex", alignItems: "center", gap: "8px", padding: "4px 0" },
  dot: (ok: boolean) => ({
    width: "8px", height: "8px", borderRadius: "50%",
    backgroundColor: ok ? "#4ade80" : "#f87171", flexShrink: 0,
  }),
  statusText: (ok: boolean) => ({
    fontSize: "11px", color: ok ? "#4ade80" : "#f87171",
    fontFamily: "monospace", wordBreak: "break-all" as const,
  }),
  valueTag: {
    fontSize: "13px", fontWeight: "bold", color: "#fff",
    background: "rgba(255,255,255,0.1)", borderRadius: "4px",
    padding: "1px 6px", fontFamily: "monospace",
  },
  warningBox: {
    background: "rgba(251,191,36,0.15)", border: "1px solid rgba(251,191,36,0.4)",
    borderRadius: "6px", padding: "8px 10px", fontSize: "11px",
    color: "rgba(251,191,36,0.9)", lineHeight: "1.5", marginTop: "4px",
  },
  methodText: {
    fontSize: "10px", color: "rgba(255,255,255,0.4)",
    fontFamily: "monospace", marginTop: "2px",
  },
  profileTag: {
    fontSize: "11px", fontWeight: "bold", color: "#fff",
    background: "rgba(74,222,128,0.25)", border: "1px solid rgba(74,222,128,0.5)",
    borderRadius: "3px", padding: "0px 5px", fontFamily: "monospace",
  },
};

// ------------------------------------------------------------------ //
// Main component
// ------------------------------------------------------------------ //

const LGoVibeControl = () => {
  const [level,             setLevel]        = useState(2);
  const [mode,              setMode]         = useState(0);
  const [touchpadIntensity, setTpIntensity]  = useState(2);
  const [touchpadEnabled,   setTpEnabled]    = useState(true);
  const [driverFound,       setDriverFound]  = useState(false);
  const [driverPaths,       setDriverPaths]  = useState([] as string[]);
  const [driverMethod,      setDriverMethod] = useState("");
  const [loading,           setLoading]      = useState(true);
  const [applying,          setApplying]     = useState(false);
  const [testing,           setTesting]      = useState(false);
  const [updateInfo,        setUpdateInfo]   = useState<{ current_version?: string; latest_version?: string; update_available?: boolean; download_url?: string; asset_name?: string; error?: string } | null>(null);
  const [checking,          setChecking]     = useState(false);
  const [downloading,       setDownloading]  = useState(false);
  const [downloadPath,      setDownloadPath] = useState<string | null>(null);

  const [perGameOn,    setPerGameOn]    = useState(false);
  const [overrideable, setOverrideable] = useState(false);
  const [gameName,     setGameName]     = useState("");

  const syncUI = useCallback(() => {
    const s = SettingsManager.current();
    setLevel(s.level);
    setMode(s.mode);
    setTpIntensity(s.touchpadIntensity);
    setTpEnabled(s.touchpadEnabled);
    setPerGameOn(SettingsManager.isOverwrite());
    setOverrideable(RunningApps.active() !== DEFAULT_APP);
    setGameName(RunningApps.displayName());
  }, []);

  // Init
  useEffect(() => {
    (async () => {
      try {
        const d = await getDriverStatus();
        setDriverFound(d.found);
        setDriverPaths(d.paths);
        setDriverMethod(d.method ?? "");
        // SettingsManager.init is called from definePlugin, but may not
        // have finished yet on first mount, so call it again (it's idempotent).
        await SettingsManager.init();
        syncUI();
      } catch (e) {
        console.error("[lego-vibe] init error", e);
      } finally {
        setLoading(false);
      }
    })();
  }, [syncUI]);

  // Listen for setting changes (game-change sync comes via SettingsManager.notify())
  useEffect(() => {
    const unsub = SettingsManager.onChange(syncUI);
    return () => { unsub(); };
  }, [syncUI]);

  // Handlers

  const handleLevelChange = useCallback(async (val: number) => {
    setApplying(true);
    try {
      const res = await setIntensity(val);
      setLevel(res.level);
      SettingsManager.set("level", res.level);
      _prevHWSettings = SettingsManager.current();
    } catch {
      setLevel(SettingsManager.current().level);
    } finally { setApplying(false); }
  }, []);

  const handleModeChange = useCallback(async (val: number) => {
    setApplying(true);
    try {
      const res = await setRumbleMode(val);
      setMode(res.mode);
      SettingsManager.set("mode", res.mode);
      _prevHWSettings = SettingsManager.current();
      void testVibration(350);
    } catch {
      setMode(SettingsManager.current().mode);
    } finally { setApplying(false); }
  }, []);

  const handleTpIntensityChange = useCallback(async (val: number) => {
    setApplying(true);
    try {
      const res = await setTouchpadIntensity(val);
      setTpIntensity(res.level);
      SettingsManager.set("touchpadIntensity", res.level);
      _prevHWSettings = SettingsManager.current();
    } catch {
      setTpIntensity(SettingsManager.current().touchpadIntensity);
    } finally { setApplying(false); }
  }, []);

  const handleTpToggle = useCallback(async (val: boolean) => {
    setApplying(true);
    try {
      setTpEnabled(val);
      await setTouchpadEnabled(val);
      SettingsManager.set("touchpadEnabled", val);
      _prevHWSettings = SettingsManager.current();
    } catch {
      setTpEnabled(SettingsManager.current().touchpadEnabled);
    } finally { setApplying(false); }
  }, []);

  const handleReset = useCallback(async () => {
    setApplying(true);
    try {
      const res = await resetToDefault();
      const snap: VibeSettings = {
        level: res.level, mode: res.mode,
        touchpadIntensity: res.touchpad_intensity,
        touchpadEnabled: res.touchpad_enabled,
      };
      setLevel(snap.level); setMode(snap.mode);
      setTpIntensity(snap.touchpadIntensity); setTpEnabled(snap.touchpadEnabled);
      SettingsManager.setAll(snap);
      _prevHWSettings = SettingsManager.current();
    } finally { setApplying(false); }
  }, []);

  const handleCheckUpdate = useCallback(async () => {
    setChecking(true);
    setUpdateInfo(null);
    setDownloadPath(null);
    try {
      const res = await checkForUpdates();
      setUpdateInfo(res);
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
      else setUpdateInfo({ ...updateInfo, error: res.error });
    } finally {
      setDownloading(false);
    }
  }, [updateInfo]);

  const handleTest = useCallback(async () => {
    setTesting(true);
    try { await testVibration(500); } finally { setTesting(false); }
  }, []);

  const handlePerGameToggle = useCallback(async (val: boolean) => {
    const prev = SettingsManager.current();
    SettingsManager.setOverwrite(val);
    setPerGameOn(val);
    if (!val) {
      setApplying(true);
      try {
        await SettingsManager.applyToHW(prev);
        _prevHWSettings = SettingsManager.current();
      } finally {
        setApplying(false);
      }
    }
    syncUI();
  }, [syncUI]);

  // Render

  if (loading) {
    return (
      <PanelSection>
        <PanelSectionRow><span>Loading...</span></PanelSectionRow>
      </PanelSection>
    );
  }

  return (
    <div style={styles.container}>
      <PanelSection title="Driver Status">
        <PanelSectionRow>
          <div style={styles.statusRow}>
            <div style={styles.dot(driverFound)} />
            <div>
              <span style={styles.statusText(driverFound)}>
                {driverFound
                  ? driverPaths[0] ?? "hid-lenovo-go found"
                  : "hid-lenovo-go driver not found"}
              </span>
              {driverFound && driverMethod && (
                <div style={styles.methodText}>via: {driverMethod}</div>
              )}
            </div>
          </div>
        </PanelSectionRow>
        {!driverFound && (
          <PanelSectionRow>
            <div style={styles.warningBox}>
              The hid-lenovo-go sysfs endpoint was not detected. Requires SteamOS 3.8+ / Kernel 6.18+ with the hid-lenovo-go module loaded on Legion Go 2 hardware.
            </div>
          </PanelSectionRow>
        )}
      </PanelSection>

      <PanelSection title="Per-Game Profile">
        <PanelSectionRow>
          <ToggleField
            label="Per Game Profile"
            description={
              overrideable ? (
                perGameOn ? (
                  <span style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                    <span>{gameName}</span>
                    <span>
                      <span style={styles.profileTag}>
                        {MODE_LABELS[mode]} | {LEVEL_LABELS[level]}
                      </span>
                    </span>
                  </span>
                ) : gameName
              ) : "Launch a game to use per-game profiles."
            }
            checked={perGameOn && overrideable}
            disabled={!overrideable}
            onChange={handlePerGameToggle}
          />
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Vibration">
        <PanelSectionRow>
          <SliderField
            label="Intensity"
            description={<span>Level: <span style={styles.valueTag}>{LEVEL_LABELS[level]}</span></span>}
            value={level} min={0} max={3} step={1} notchCount={4}
            notchLabels={[
              { notchIndex: 0, label: "Off" }, { notchIndex: 1, label: "Low" },
              { notchIndex: 2, label: "Med" }, { notchIndex: 3, label: "High" },
            ]}
            disabled={applying}
            onChange={(val: number) => { setLevel(val); void handleLevelChange(val); }}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <SliderField
            label="Mode"
            description={<span>Mode: <span style={styles.valueTag}>{MODE_LABELS[mode]}</span></span>}
            value={mode} min={0} max={4} step={1} notchCount={5}
            notchLabels={[
              { notchIndex: 0, label: "FPS" }, { notchIndex: 1, label: "Race" },
              { notchIndex: 2, label: "Std" }, { notchIndex: 3, label: "SPG" },
              { notchIndex: 4, label: "RPG" },
            ]}
            disabled={applying}
            onChange={(val: number) => { setMode(val); void handleModeChange(val); }}
          />
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Touchpad">
        <PanelSectionRow>
          <ToggleField
            label="Touchpad vibration"
            description="Enable vibration on touchpad"
            checked={touchpadEnabled}
            disabled={applying}
            onChange={handleTpToggle}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <SliderField
            label="Touchpad intensity"
            description={<span>Level: <span style={styles.valueTag}>{LEVEL_LABELS[touchpadIntensity]}</span></span>}
            value={touchpadIntensity} min={0} max={3} step={1} notchCount={4}
            notchLabels={[
              { notchIndex: 0, label: "Off" }, { notchIndex: 1, label: "Low" },
              { notchIndex: 2, label: "Med" }, { notchIndex: 3, label: "High" },
            ]}
            disabled={applying || !touchpadEnabled}
            onChange={(val: number) => { setTpIntensity(val); void handleTpIntensityChange(val); }}
          />
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Actions">
        <PanelSectionRow>
          <ButtonItem layout="below"
            description="Tests current intensity & mode."
            onClick={handleTest} disabled={applying || testing}>
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
          <div style={{ fontSize: "12px", color: "rgba(255,255,255,0.6)" }}>
            Installed: <span style={styles.valueTag}>v{updateInfo?.current_version ?? "1.3.3"}</span>
            {updateInfo?.latest_version && !updateInfo.error && (
              <span> &nbsp; Latest: <span style={styles.valueTag}>v{updateInfo.latest_version}</span></span>
            )}
          </div>
        </PanelSectionRow>
        {updateInfo?.error && (
          <PanelSectionRow>
            <div style={{ ...styles.warningBox, color: "#f87171", borderColor: "rgba(248,113,113,0.4)", background: "rgba(248,113,113,0.1)" }}>
              {updateInfo.error}
            </div>
          </PanelSectionRow>
        )}
        {updateInfo && !updateInfo.error && !updateInfo.update_available && !downloadPath && (
          <PanelSectionRow>
            <div style={{ fontSize: "12px", color: "#4ade80" }}>Up to date</div>
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
            <div style={styles.warningBox}>
              Downloaded to <span style={{ fontFamily: "monospace", wordBreak: "break-all" }}>{downloadPath}</span>
              <br /><br />
              To install: Decky → Developer → Uninstall LeGo Vibe Control → Install Plugin from ZIP → select the file.
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
          <div style={styles.warningBox}>
            Intensity levels: Off → Low → Medium → High. Mode selects vibration pattern:
            FPS, Racing, Standard, SPG, RPG — applied globally to both handles.
            Settings persist across reboots.
            Per-game profiles auto-apply when a game with a saved profile starts.
          </div>
        </PanelSectionRow>
      </PanelSection>
    </div>
  );
};

// ------------------------------------------------------------------ //
// Plugin entry point
// ------------------------------------------------------------------ //

let _prevHWSettings: VibeSettings | null = null;

export default definePlugin(() => {
  RunningApps.register();
  let active = true;

  SettingsManager.init().then(() => {
    if (!active) return;
    _prevHWSettings = SettingsManager.current();

    RunningApps.listen(async () => {
      const prev = _prevHWSettings;
      const next = SettingsManager.current();
      try {
        await SettingsManager.applyToHW(prev);
        _prevHWSettings = next;
      } finally {
        SettingsManager.notify();
      }
    });
  });

  return {
    name: "LeGo Vibe Control",
    titleView: <span>LeGo Vibe Control</span>,
    content: <LGoVibeControl />,
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"
        style={{ width: "1em", height: "1em" }}>
        <path d="M0 15h2V9H0v6zm3 2h2V7H3v10zm19-8v6h2V9h-2zm-3 8h2V7h-2v10zm-7-1c2.76 0 5-2.24 5-5s-2.24-5-5-5-5 2.24-5 5 2.24 5 5 5zm0-8c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3z" />
      </svg>
    ),
    onDismount() {
      active = false;
      RunningApps.unregister();
    },
  };
});

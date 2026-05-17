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

  // Load profiles from backend
  static async init() {
    const [s, gp] = await Promise.all([getSettings(), getGameProfiles()]);
    this.perApp = gp || {};
    // Seed DEFAULT_APP from current backend settings
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
  perGameTag: {
    fontSize: "10px", padding: "1px 5px", borderRadius: "3px",
    background: "rgba(96,165,250,0.2)", color: "rgba(96,165,250,0.9)",
    fontWeight: "bold", marginLeft: "6px",
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

  // Listen for app changes and setting changes
  useEffect(() => {
    const unsub1 = RunningApps.listen(() => syncUI());
    const unsub2 = SettingsManager.onChange(syncUI);
    return () => { unsub1(); unsub2(); };
  }, [syncUI]);

  // Handlers

  const handleLevelChange = useCallback(async (val: number) => {
    setApplying(true);
    try {
      const res = await setIntensity(val);
      setLevel(res.level);
      SettingsManager.set("level", res.level);
      _prevHWSettings = SettingsManager.current();
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
    } finally { setApplying(false); }
  }, []);

  const handleTpIntensityChange = useCallback(async (val: number) => {
    setApplying(true);
    try {
      const res = await setTouchpadIntensity(val);
      setTpIntensity(res.level);
      SettingsManager.set("touchpadIntensity", res.level);
      _prevHWSettings = SettingsManager.current();
    } finally { setApplying(false); }
  }, []);

  const handleTpToggle = useCallback(async (val: boolean) => {
    setTpEnabled(val);
    await setTouchpadEnabled(val);
    SettingsManager.set("touchpadEnabled", val);
    _prevHWSettings = SettingsManager.current();
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

  const handleTest = useCallback(async () => {
    setTesting(true);
    try { await testVibration(500); } finally { setTesting(false); }
  }, []);

  const handlePerGameToggle = useCallback(async (val: boolean) => {
    const prev = SettingsManager.current();
    SettingsManager.setOverwrite(val);
    setPerGameOn(val);
    // If turning off, apply global settings
    if (!val) {
      await SettingsManager.applyToHW(prev);
      syncUI();
    }
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
            label={
              <span>
                Use per-game profile
                {perGameOn && overrideable && (
                  <span style={styles.perGameTag}>{gameName}</span>
                )}
              </span>
            }
            description={
              perGameOn && overrideable
                ? "Settings below apply only to this game."
                : overrideable
                  ? "Enable to save separate settings for this game."
                  : "Launch a game to use per-game profiles."
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

  // Init and register app-change handler at plugin level so it works
  // even when the QAM panel is closed.
  SettingsManager.init().then(() => {
    _prevHWSettings = SettingsManager.current();

    RunningApps.listen(async () => {
      const prev = _prevHWSettings;
      const next = SettingsManager.current();
      _prevHWSettings = next;
      await SettingsManager.applyToHW(prev);
      SettingsManager.notify();
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
    onDismount() { RunningApps.unregister(); },
  };
});

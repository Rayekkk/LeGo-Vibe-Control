import {
  ButtonItem,
  PanelSection,
  PanelSectionRow,
  Router,
  SliderField,
  ToggleField,
} from "@decky/ui";
import { callable, definePlugin } from "@decky/api";

declare const SP_REACT: any;
const { useState, useEffect, useCallback } = SP_REACT;

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

const DEFAULT_APP = "0";
const LEVEL_LABELS = ["Off", "Low", "Medium", "High"];
const MODE_LABELS  = ["FPS", "Racing", "Standard", "SPG", "RPG"];

// Running apps polling

type ActiveAppChangedHandler = (newAppId: string, oldAppId: string) => void;

class RunningApps {
  private static listeners: ActiveAppChangedHandler[] = [];
  private static lastAppId: string = DEFAULT_APP;
  private static intervalId: ReturnType<typeof setInterval> | undefined;

  private static pollActive() {
    const newApp = RunningApps.active();
    if (this.lastAppId !== newApp) {
      const old = this.lastAppId;
      this.lastAppId = newApp;
      this.listeners.forEach((h) => h(newApp, old));
    }
  }

  static register() {
    if (this.intervalId === undefined) {
      this.intervalId = setInterval(() => this.pollActive(), 100);
    }
  }

  static unregister() {
    if (this.intervalId !== undefined) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.listeners.splice(0, this.listeners.length);
  }

  static listenActiveChange(fn: ActiveAppChangedHandler): () => void {
    const idx = this.listeners.push(fn) - 1;
    return () => { this.listeners.splice(idx, 1); };
  }

  static active(): string {
    return String(Router?.MainRunningApp?.appid || 0);
  }

  static activeDisplayName(): string {
    const app = Router?.MainRunningApp;
    if (app && app.appid) {
      return app.display_name || `App ${app.appid}`;
    }
    return "";
  }
}

// Backend callables

const getSettings = callable<[], {
  level: number; mode: number;
  touchpad_intensity: number; touchpad_enabled: boolean;
}>("get_settings");

const setIntensity = callable<[level: number], { success: boolean; level: number }>(
  "set_intensity"
);
const setRumbleMode = callable<[mode_idx: number], { success: boolean; mode: number }>(
  "set_rumble_mode"
);
const resetToDefault = callable<[], {
  success: boolean; level: number; mode: number;
  touchpad_intensity: number; touchpad_enabled: boolean;
}>("reset_to_default");
const getDriverStatus = callable<[], { found: boolean; paths: string[]; method: string }>(
  "get_driver_status"
);
const testVibration = callable<[duration_ms: number], { success: boolean; error?: string }>(
  "test_vibration"
);
const setTouchpadIntensity = callable<[level: number], { success: boolean; level: number }>(
  "set_touchpad_intensity"
);
const setTouchpadEnabled = callable<[enabled: boolean], { success: boolean; enabled: boolean }>(
  "set_touchpad_enabled"
);
const getGameProfiles = callable<[], GameProfiles>("get_game_profiles");
const setGameProfiles = callable<[profiles: GameProfiles], { success: boolean }>("set_game_profiles");
const applyHwOnly = callable<[settings_dict: VibeSettings], { success: boolean }>("apply_hw_only");
const saveGlobalSettings = callable<[settings_dict: VibeSettings], { success: boolean }>("save_global_settings");

// SettingsManager

class SettingsManager {
  private static perApp: GameProfiles = {};
  private static changeListeners: Array<() => void> = [];

  //Defaults used for global
  private static defaults: VibeSettings = {
    level: 2, mode: 0, touchpadIntensity: 2, touchpadEnabled: true,
  };

  static onSettingChange(fn: () => void): () => void {
    this.changeListeners.push(fn);
    return () => {
      this.changeListeners = this.changeListeners.filter((f) => f !== fn);
    };
  }

  static notifyChange() {
    this.changeListeners.forEach((fn) => fn());
  }

  static async init() {
    const [s, gp] = await Promise.all([getSettings(), getGameProfiles()]);
    this.defaults = {
      level: s.level,
      mode: s.mode ?? 0,
      touchpadIntensity: s.touchpad_intensity ?? 2,
      touchpadEnabled: s.touchpad_enabled ?? true,
    };
    this.perApp = gp || {};
    if (!(DEFAULT_APP in this.perApp)) {
      this.perApp[DEFAULT_APP] = { overwrite: false, settings: { ...this.defaults } };
    }
  }

  private static save() {
    void setGameProfiles({ ...this.perApp });
    const def = this.perApp[DEFAULT_APP];
    if (def) {
      void saveGlobalSettings(def.settings);
    }
  }

  private static ensureApp(appId: string): PerAppEntry {
    if (!(appId in this.perApp)) {
      this.perApp[appId] = {
        overwrite: false,
        settings: { ...this.currentSettings() },
      };
    }
    return this.perApp[appId];
  }

  private static resolvedAppId(): string {
    const appId = RunningApps.active();
    if (appId !== DEFAULT_APP) {
      const entry = this.perApp[appId];
      if (entry && entry.overwrite) {
        return appId;
      }
    }
    return DEFAULT_APP;
  }

  // Get the currently active settings
  static currentSettings(): VibeSettings {
    const appId = this.resolvedAppId();
    const entry = this.perApp[appId];
    return entry ? { ...entry.settings } : { ...this.defaults };
  }

  static appOverwrite(): boolean {
    const appId = RunningApps.active();
    if (appId === DEFAULT_APP) return false;
    return this.perApp[appId]?.overwrite ?? false;
  }

  // Toggle per-game override on/off for the current running game
  static setOverwrite(value: boolean) {
    const appId = RunningApps.active();
    if (appId === DEFAULT_APP) return;
    const entry = this.ensureApp(appId);
    if (entry.overwrite !== value) {
      entry.overwrite = value;
      this.save();
      void this.applyCurrentToHW();
      this.notifyChange();
    }
  }

  static async setSetting<K extends keyof VibeSettings>(key: K, value: VibeSettings[K]) {
    const appId = this.resolvedAppId();
    const entry = this.ensureApp(appId);
    entry.settings[key] = value;
    if (appId === DEFAULT_APP) {
      this.defaults[key] = value;
    }
    this.save();
  }

  static setAllSettings(s: VibeSettings) {
    const appId = this.resolvedAppId();
    const entry = this.ensureApp(appId);
    entry.settings = { ...s };
    if (appId === DEFAULT_APP) {
      this.defaults = { ...s };
    }
    this.save();
  }

  static async applyCurrentToHW() {
    const s = this.currentSettings();
    await applyHwOnly(s);
  }
}

// ------------------------------------------------------------------ //
// Styles
// ------------------------------------------------------------------ //

const styles = {
  container: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "4px",
  },
  statusRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "4px 0",
  },
  dot: (ok: boolean) => ({
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    backgroundColor: ok ? "#4ade80" : "#f87171",
    flexShrink: 0,
  }),
  statusText: (ok: boolean) => ({
    fontSize: "11px",
    color: ok ? "#4ade80" : "#f87171",
    fontFamily: "monospace",
    wordBreak: "break-all" as const,
  }),
  valueTag: {
    fontSize: "13px",
    fontWeight: "bold",
    color: "#fff",
    background: "rgba(255,255,255,0.1)",
    borderRadius: "4px",
    padding: "1px 6px",
    fontFamily: "monospace",
  },
  warningBox: {
    background: "rgba(251,191,36,0.15)",
    border: "1px solid rgba(251,191,36,0.4)",
    borderRadius: "6px",
    padding: "8px 10px",
    fontSize: "11px",
    color: "rgba(251,191,36,0.9)",
    lineHeight: "1.5",
    marginTop: "4px",
  },
  methodText: {
    fontSize: "10px",
    color: "rgba(255,255,255,0.4)",
    fontFamily: "monospace",
    marginTop: "2px",
  },
  perGameTag: {
    fontSize: "10px",
    padding: "1px 5px",
    borderRadius: "3px",
    background: "rgba(96,165,250,0.2)",
    color: "rgba(96,165,250,0.9)",
    fontWeight: "bold",
    marginLeft: "6px",
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
  const [driverPaths,       setDriverPaths]  = useState([]);
  const [driverMethod,      setDriverMethod] = useState("");
  const [loading,           setLoading]      = useState(true);
  const [applying,          setApplying]     = useState(false);
  const [testing,           setTesting]      = useState(false);

  // Per-game state
  const [perGameOn,    setPerGameOn]    = useState(false);
  const [overrideable, setOverrideable] = useState(RunningApps.active() !== DEFAULT_APP);
  const [gameName,     setGameName]     = useState(RunningApps.activeDisplayName());

  const syncUI = useCallback(() => {
    const s = SettingsManager.currentSettings();
    setLevel(s.level);
    setMode(s.mode);
    setTpIntensity(s.touchpadIntensity);
    setTpEnabled(s.touchpadEnabled);
    setPerGameOn(SettingsManager.appOverwrite());
    setOverrideable(RunningApps.active() !== DEFAULT_APP);
    setGameName(RunningApps.activeDisplayName());
  }, []);

  useEffect(() => {
    const init = async () => {
      try {
        const d = await getDriverStatus();
        setDriverFound(d.found);
        setDriverPaths(d.paths);
        setDriverMethod(d.method ?? "");
        await SettingsManager.init();
        syncUI();
      } catch (e) {
        console.error("[lego-vibe] init error", e);
      } finally {
        setLoading(false);
      }
    };
    init();
  }, [syncUI]);

  // Listen for settings changes
  useEffect(() => {
    const unSetting = SettingsManager.onSettingChange(syncUI);
    const unApp = RunningApps.listenActiveChange(() => syncUI());
    return () => { unSetting(); unApp(); };
  }, [syncUI]);

  // Setting change handlers

  const handleLevelChange = useCallback(async (val: number) => {
    setApplying(true);
    try {
      setLevel(val);
      await SettingsManager.setSetting("level", val);
      await SettingsManager.applyCurrentToHW();
    } finally { setApplying(false); }
  }, []);

  const handleModeChange = useCallback(async (val: number) => {
    setApplying(true);
    try {
      setMode(val);
      await SettingsManager.setSetting("mode", val);
      await SettingsManager.applyCurrentToHW();
      void testVibration(350);
    } finally { setApplying(false); }
  }, []);

  const handleTouchpadLevelChange = useCallback(async (val: number) => {
    setApplying(true);
    try {
      setTpIntensity(val);
      await SettingsManager.setSetting("touchpadIntensity", val);
      await SettingsManager.applyCurrentToHW();
    } finally { setApplying(false); }
  }, []);

  const handleTouchpadToggle = useCallback(async (val: boolean) => {
    setTpEnabled(val);
    await SettingsManager.setSetting("touchpadEnabled", val);
    await SettingsManager.applyCurrentToHW();
  }, []);

  const handleReset = useCallback(async () => {
    setApplying(true);
    try {
      const snap: VibeSettings = {
        level: 2, mode: 0, touchpadIntensity: 2, touchpadEnabled: true,
      };
      setLevel(snap.level);
      setMode(snap.mode);
      setTpIntensity(snap.touchpadIntensity);
      setTpEnabled(snap.touchpadEnabled);
      SettingsManager.setAllSettings(snap);
      await SettingsManager.applyCurrentToHW();
    } finally { setApplying(false); }
  }, []);

  const handleTest = useCallback(async () => {
    setTesting(true);
    try { await testVibration(500); } finally { setTesting(false); }
  }, []);

  // Per-game toggle

  const handlePerGameToggle = useCallback((val: boolean) => {
    SettingsManager.setOverwrite(val);
    setPerGameOn(val);
  }, []);

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

      {/* Per-game toggle — always visible, disabled when no game running */}
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
            description={
              <span>
                Level: <span style={styles.valueTag}>{LEVEL_LABELS[level]}</span>
              </span>
            }
            value={level}
            min={0}
            max={3}
            step={1}
            notchCount={4}
            notchLabels={[
              { notchIndex: 0, label: "Off" },
              { notchIndex: 1, label: "Low" },
              { notchIndex: 2, label: "Med" },
              { notchIndex: 3, label: "High" },
            ]}
            disabled={applying}
            onChange={(val: number) => {
              setLevel(val);
              void handleLevelChange(val);
            }}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <SliderField
            label="Mode"
            description={
              <span>
                Mode: <span style={styles.valueTag}>{MODE_LABELS[mode]}</span>
              </span>
            }
            value={mode}
            min={0}
            max={4}
            step={1}
            notchCount={5}
            notchLabels={[
              { notchIndex: 0, label: "FPS" },
              { notchIndex: 1, label: "Race" },
              { notchIndex: 2, label: "Std" },
              { notchIndex: 3, label: "SPG" },
              { notchIndex: 4, label: "RPG" },
            ]}
            disabled={applying}
            onChange={(val: number) => {
              setMode(val);
              void handleModeChange(val);
            }}
          />
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Touchpad">
        <PanelSectionRow>
          <ToggleField
            label="Touchpad vibration"
            description="Enable vibration on touchpad"
            checked={touchpadEnabled}
            onChange={handleTouchpadToggle}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <SliderField
            label="Touchpad intensity"
            description={
              <span>
                Level: <span style={styles.valueTag}>{LEVEL_LABELS[touchpadIntensity]}</span>
              </span>
            }
            value={touchpadIntensity}
            min={0}
            max={3}
            step={1}
            notchCount={4}
            notchLabels={[
              { notchIndex: 0, label: "Off" },
              { notchIndex: 1, label: "Low" },
              { notchIndex: 2, label: "Med" },
              { notchIndex: 3, label: "High" },
            ]}
            disabled={applying || !touchpadEnabled}
            onChange={(val: number) => {
              setTpIntensity(val);
              void handleTouchpadLevelChange(val);
            }}
          />
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Actions">
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            description="Tests current intensity & mode."
            onClick={handleTest}
            disabled={applying || testing}
          >
            {testing ? "Vibrating..." : "Test Vibration (0.5s)"}
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            onClick={handleReset}
            disabled={applying || testing}
          >
            Reset to defaults
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Notes">
        <PanelSectionRow>
          <div style={styles.warningBox}>
            Intensity levels: Off → Low → Medium → High. Mode selects vibration pattern: FPS, Racing, Standard, SPG, RPG — applied globally to both handles. Settings persist across reboots. Per-game profiles auto-apply when a game with a saved profile starts.
          </div>
        </PanelSectionRow>
      </PanelSection>
    </div>
  );
};

// ------------------------------------------------------------------ //
// Plugin entry point
// ------------------------------------------------------------------ //

export default definePlugin(() => {
  RunningApps.register();

  // Init settings and register the app-change listener at plugin level,
  SettingsManager.init().then(() => {
    RunningApps.listenActiveChange(async () => {
      await SettingsManager.applyCurrentToHW();
      // notifyChange triggers UI sync if the plugin page is opened
      SettingsManager.notifyChange();
    });
  });

  return {
    name: "LeGo Vibe Control",
    titleView: <span>LeGo Vibe Control</span>,
    content: <LGoVibeControl />,
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style={{ width: "1em", height: "1em" }}>
        <path d="M0 15h2V9H0v6zm3 2h2V7H3v10zm19-8v6h2V9h-2zm-3 8h2V7h-2v10zm-7-1c2.76 0 5-2.24 5-5s-2.24-5-5-5-5 2.24-5 5 2.24 5 5 5zm0-8c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3z" />
      </svg>
    ),
    onDismount() {
      RunningApps.unregister();
    },
  };
});

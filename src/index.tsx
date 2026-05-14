import {
  ButtonItem,
  PanelSection,
  PanelSectionRow,
  SliderField,
  ToggleField,
} from "@decky/ui";
import { callable, definePlugin } from "@decky/api";

declare const SP_REACT: any;
const { useState, useEffect, useCallback } = SP_REACT;

// Module-level cache: survives component remounts within the same plugin session.
let _cache: { level: number; mode: number; touchpadIntensity: number; touchpadEnabled: boolean } | null = null;

const LEVEL_LABELS = ["Off", "Low", "Medium", "High"];
const MODE_LABELS  = ["FPS", "Racing", "Standard", "SPG", "RPG"];

// ------------------------------------------------------------------ //
// Backend callables
// ------------------------------------------------------------------ //

const getSettings = callable<[], { level: number; mode: number; touchpad_intensity: number; touchpad_enabled: boolean }>(
  "get_settings"
);

const setIntensity = callable<[level: number], { success: boolean; level: number }>(
  "set_intensity"
);

const setRumbleMode = callable<[mode_idx: number], { success: boolean; mode: number }>(
  "set_rumble_mode"
);

const resetToDefault = callable<[], { success: boolean; level: number; mode: number; touchpad_intensity: number; touchpad_enabled: boolean }>(
  "reset_to_default"
);

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
};

// ------------------------------------------------------------------ //
// Main component
// ------------------------------------------------------------------ //

const LGoVibeControl = () => {
  const [level,        setLevel]        = useState<number>(_cache?.level        ?? 2);
  const [mode,         setMode]         = useState<number>(_cache?.mode         ?? 0);
  const [touchpadIntensity, setTpIntensity] = useState<number>(_cache?.touchpadIntensity  ?? 2);
  const [touchpadEnabled,   setTpEnabled]   = useState<boolean>(_cache?.touchpadEnabled   ?? true);
  const [driverFound,  setDriverFound]  = useState<boolean>(false);
  const [driverPaths,  setDriverPaths]  = useState<string[]>([]);
  const [driverMethod, setDriverMethod] = useState<string>("");
  const [loading,      setLoading]      = useState<boolean>(_cache === null);
  const [applying,     setApplying]     = useState<boolean>(false);
  const [testing,      setTesting]      = useState<boolean>(false);

  useEffect(() => {
    const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
      Promise.race([
        p,
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error(`backend timeout after ${ms}ms`)), ms)
        ),
      ]);

    const init = async () => {
      try {
        const [s, d] = await withTimeout(
          Promise.all([getSettings(), getDriverStatus()]),
          5000
        );
        _cache = {
          level: s.level,
          mode: s.mode ?? 0,
          touchpadIntensity: s.touchpad_intensity ?? 2,
          touchpadEnabled: s.touchpad_enabled ?? true,
        };
        setLevel(s.level);
        setMode(s.mode ?? 0);
        setTpIntensity(s.touchpad_intensity ?? 2);
        setTpEnabled(s.touchpad_enabled ?? true);
        setDriverFound(d.found);
        setDriverPaths(d.paths);
        setDriverMethod(d.method ?? "");
      } catch (e) {
        console.error("[lgo2-vibe] init error", e);
      } finally {
        setLoading(false);
      }
    };
    init();
  }, []);

  const handleLevelChange = useCallback(async (val: number) => {
    setApplying(true);
    try {
      const res = await setIntensity(val);
      setLevel(res.level);
      if (_cache) _cache.level = res.level;
    } finally {
      setApplying(false);
    }
  }, []);

  const handleModeChange = useCallback(async (val: number) => {
    setApplying(true);
    try {
      const res = await setRumbleMode(val);
      setMode(res.mode);
      if (_cache) _cache.mode = res.mode;
      void testVibration(350);
    } finally {
      setApplying(false);
    }
  }, []);

  const handleTouchpadLevelChange = useCallback(async (val: number) => {
    setApplying(true);
    try {
      const res = await setTouchpadIntensity(val);
      setTpIntensity(res.level);
      if (_cache) _cache.touchpadIntensity = res.level;
    } finally {
      setApplying(false);
    }
  }, []);

  const handleTouchpadToggle = useCallback(async (val: boolean) => {
    setTpEnabled(val);
    if (_cache) _cache.touchpadEnabled = val;
    await setTouchpadEnabled(val);
  }, []);

  const handleReset = useCallback(async () => {
    setApplying(true);
    try {
      const res = await resetToDefault();
      setLevel(res.level);
      setMode(res.mode);
      setTpIntensity(res.touchpad_intensity);
      setTpEnabled(res.touchpad_enabled);
      if (_cache) {
        _cache.level = res.level;
        _cache.mode = res.mode;
        _cache.touchpadIntensity = res.touchpad_intensity;
        _cache.touchpadEnabled = res.touchpad_enabled;
      }
    } finally {
      setApplying(false);
    }
  }, []);

  const handleTest = useCallback(async () => {
    setTesting(true);
    try {
      await testVibration(500);
    } finally {
      setTesting(false);
    }
  }, []);

  if (loading) {
    return (
      <PanelSection>
        <PanelSectionRow>
          <span>Loading...</span>
        </PanelSectionRow>
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
            description="Tests current intensity & mode. Always fires on both handles — per-handle toggles don't apply to hardware FF."
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
            Intensity levels: Off → Low → Medium → High. Mode selects vibration pattern: FPS, Racing, Standard, SPG, RPG — applied globally to both handles. Settings persist across reboots.
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
  return {
    name: "LeGo Vibe Control",
    titleView: <span>LeGo Vibe Control</span>,
    content: <LGoVibeControl />,
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style={{ width: "1em", height: "1em" }}>
        <path d="M0 15h2V9H0v6zm3 2h2V7H3v10zm19-8v6h2V9h-2zm-3 8h2V7h-2v10zm-7-1c2.76 0 5-2.24 5-5s-2.24-5-5-5-5 2.24-5 5 2.24 5 5 5zm0-8c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3z" />
      </svg>
    ),
    onDismount() {},
  };
});

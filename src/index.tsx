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
let _cache: { level: number; leftEnabled: boolean; rightEnabled: boolean } | null = null;

const LEVEL_LABELS = ["Off", "Low", "Medium", "High"];

// ------------------------------------------------------------------ //
// Backend callables
// ------------------------------------------------------------------ //

const getSettings = callable<[], { level: number; left_enabled: boolean; right_enabled: boolean }>(
  "get_settings"
);

const setIntensity = callable<[level: number], { success: boolean; level: number }>(
  "set_intensity"
);

const setHandleEnabled = callable<[handle: string, enabled: boolean], { success: boolean; handle: string; enabled: boolean }>(
  "set_handle_enabled"
);

const resetToDefault = callable<[], { success: boolean; level: number }>(
  "reset_to_default"
);

const getDriverStatus = callable<[], { found: boolean; paths: string[] }>(
  "get_driver_status"
);

const testVibration = callable<[duration_ms: number], { success: boolean; error?: string }>(
  "test_vibration"
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
};

// ------------------------------------------------------------------ //
// Main component
// ------------------------------------------------------------------ //

const LGoVibeControl = () => {
  const [level,        setLevel]        = useState<number>(_cache?.level        ?? 2);
  const [leftEnabled,  setLeftEnabled]  = useState<boolean>(_cache?.leftEnabled  ?? true);
  const [rightEnabled, setRightEnabled] = useState<boolean>(_cache?.rightEnabled ?? true);
  const [driverFound,  setDriverFound]  = useState<boolean>(false);
  const [driverPaths,  setDriverPaths]  = useState<string[]>([]);
  const [loading,      setLoading]      = useState<boolean>(_cache === null);
  const [applying,     setApplying]     = useState<boolean>(false);
  const [testing,      setTesting]      = useState<boolean>(false);

  useEffect(() => {
    const init = async () => {
      try {
        const [s, d] = await Promise.all([getSettings(), getDriverStatus()]);
        _cache = { level: s.level, leftEnabled: s.left_enabled, rightEnabled: s.right_enabled };
        setLevel(s.level);
        setLeftEnabled(s.left_enabled);
        setRightEnabled(s.right_enabled);
        setDriverFound(d.found);
        setDriverPaths(d.paths);
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

  const handleLeftToggle = useCallback(async (val: boolean) => {
    setLeftEnabled(val);
    if (_cache) _cache.leftEnabled = val;
    await setHandleEnabled("left", val);
  }, []);

  const handleRightToggle = useCallback(async (val: boolean) => {
    setRightEnabled(val);
    if (_cache) _cache.rightEnabled = val;
    await setHandleEnabled("right", val);
  }, []);

  const handleReset = useCallback(async () => {
    setApplying(true);
    try {
      const res = await resetToDefault();
      setLevel(res.level);
      if (_cache) _cache.level = res.level;
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
            <span style={styles.statusText(driverFound)}>
              {driverFound
                ? driverPaths[0] ?? "hid-lenovo-go found"
                : "hid-lenovo-go driver not found"}
            </span>
          </div>
        </PanelSectionRow>
        {!driverFound && (
          <PanelSectionRow>
            <div style={styles.warningBox}>
              The hid-lenovo-go sysfs endpoint was not detected. Requires Linux
              7.1+ with the hid-lenovo-go module loaded on Legion Go 2 hardware.
            </div>
          </PanelSectionRow>
        )}
      </PanelSection>

      <PanelSection title="Vibration Intensity">
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
      </PanelSection>

      <PanelSection title="Controllers">
        <PanelSectionRow>
          <ToggleField
            label="Left controller rumble"
            description="Enable vibration on left handle"
            checked={leftEnabled}
            onChange={handleLeftToggle}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ToggleField
            label="Right controller rumble"
            description="Enable vibration on right handle"
            checked={rightEnabled}
            onChange={handleRightToggle}
          />
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Actions">
        <PanelSectionRow>
          <ButtonItem
            layout="below"
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
            Reset to Medium (default)
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Notes">
        <PanelSectionRow>
          <div style={styles.warningBox}>
            Intensity maps to driver levels: Off / Low / Medium / High.
            Per-handle toggles write to left_handle/rumble_notification and
            right_handle/rumble_notification. Settings persist across reboots.
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
    name: "Legion Vibe Control",
    titleView: <span>Legion Vibe Control</span>,
    content: <LGoVibeControl />,
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style={{ width: "1em", height: "1em" }}>
        <path d="M0 15h2V9H0v6zm3 2h2V7H3v10zm19-8v6h2V9h-2zm-3 8h2V7h-2v10zm-7-1c2.76 0 5-2.24 5-5s-2.24-5-5-5-5 2.24-5 5 2.24 5 5 5zm0-8c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3z" />
      </svg>
    ),
    onDismount() {},
  };
});

import {
  computeKnownCoverage,
  DEFAULT_SANDBOX_CONFIG,
  projectGraph,
  resolveNodeIndex,
  scoreGraph,
  type GraphDataset,
  type KnownCoverageSummary,
  type ProjectedGraph,
  type SandboxConfig,
  type ScoreResult,
} from "@fuluoxiaojie/graph-engine";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  api,
  ApiError,
  setUnauthorizedHandler,
  type AuthStatus,
  type ExamplesMap,
  type NodeStatus,
  type ProgressEntry,
  type SandboxPreset,
  type SrsSettings,
  type UserSettings,
} from "../api/client.js";
import { clearMandarinAudioCache } from "./useAudio.js";

export type AppTab = "explorer" | "sandbox" | "planner" | "review" | "stats";

interface AppStateContextValue {
  auth: AuthStatus | null;
  loading: boolean;
  loadError: string | null;
  activeTab: AppTab;
  setActiveTab: (tab: AppTab) => void;
  dataset: GraphDataset | null;
  examples: ExamplesMap;
  projected: ProjectedGraph | null;
  sandboxConfig: SandboxConfig;
  setSandboxConfig: (updater: SandboxConfig | ((prev: SandboxConfig) => SandboxConfig)) => void;
  settings: UserSettings;
  presets: SandboxPreset[];
  progress: Record<string, ProgressEntry>;
  knownIds: Set<string>;
  ignoredIds: Set<string>;
  learningIds: Set<string>;
  enrolledNodeIds: Set<string>;
  scoreResult: ScoreResult | null;
  coverageSummary: KnownCoverageSummary | null;
  dueCount: number;
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;
  openInExplorer: (id: string) => void;
  refreshAuthAndData: () => Promise<void>;
  refreshDueAndCards: () => Promise<void>;
  updateNodeProgress: (
    nodeId: string,
    patch: { status?: NodeStatus; notes?: string }
  ) => Promise<void>;
  bulkImportProgress: (
    payload: Parameters<typeof api.bulkImportProgress>[0]
  ) => Promise<{ importedCount: number; status: NodeStatus; nodeIds: string[] }>;
  enrollNodes: (nodeIds: string[]) => Promise<{ enrolledNodes: string[]; createdCards: number }>;
  unenrollNode: (nodeId: string) => Promise<void>;
  ensureServerMergeModeAligned: () => Promise<void>;
  saveSettings: (patch: { sandbox?: Partial<SandboxConfig>; srs?: Partial<SrsSettings> }) => Promise<void>;
  savePreset: (name: string) => Promise<void>;
  deletePreset: (id: string) => Promise<void>;
  restoreBackup: (
    json: unknown
  ) => Promise<{ ok: boolean; restoredProgress: number; restoredCards: number; restoredLogs: number }>;
  logout: () => Promise<void>;
}

const DEFAULT_SETTINGS: UserSettings = {
  sandbox: { ...DEFAULT_SANDBOX_CONFIG },
  srs: {
    dailyNewLimit: 15,
    requestRetention: 0.9,
    masteryStabilityDays: 7,
    enabledModes: { recognition: true, stroke: true, component: true, listening: true },
    enableTypingInRecognition: true,
  },
};

const AppStateContext = createContext<AppStateContextValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>("explorer");

  const [dataset, setDataset] = useState<GraphDataset | null>(null);
  const [examples, setExamples] = useState<ExamplesMap>({});
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [sandboxConfig, setSandboxConfig] = useState<SandboxConfig>({ ...DEFAULT_SANDBOX_CONFIG });
  const [presets, setPresets] = useState<SandboxPreset[]>([]);
  const [progress, setProgress] = useState<Record<string, ProgressEntry>>({});
  const [enrolledNodeIds, setEnrolledNodeIds] = useState<Set<string>>(new Set());
  const [dueCount, setDueCount] = useState(0);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>("青");

  const sandboxConfigRef = useRef(sandboxConfig);
  sandboxConfigRef.current = sandboxConfig;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const clearSessionState = useCallback(() => {
    clearMandarinAudioCache();
    setDataset(null);
    setExamples({});
    setProgress({});
    setPresets([]);
    setEnrolledNodeIds(new Set());
    setDueCount(0);
    setLoadError(null);
    const freshSandbox = { ...DEFAULT_SANDBOX_CONFIG };
    settingsRef.current = DEFAULT_SETTINGS;
    sandboxConfigRef.current = freshSandbox;
    setSettings(DEFAULT_SETTINGS);
    setSandboxConfig(freshSandbox);
  }, []);

  // Register global 401 session-expiration handler so mid-session timeouts cleanly return to AuthGate
  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearSessionState();
      setAuth((prev) =>
        prev
          ? { ...prev, authenticated: false }
          : { authDisabled: false, configured: true, authenticated: false }
      );
    });
    return () => setUnauthorizedHandler(null);
  }, [clearSessionState]);

  const refreshDueAndCards = useCallback(async () => {
    const [dueRes, cardsRes, progRes] = await Promise.all([
      api.getDueCards(undefined, 1),
      api.getSrsCards(),
      api.getProgress(),
    ]);
    setDueCount(dueRes.dueCount);
    setEnrolledNodeIds(new Set(cardsRes.cards.map((c) => c.node_id)));
    setProgress(progRes.items);
  }, []);

  const refreshAuthAndData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const authStatus = await api.getAuthStatus();
      setAuth(authStatus);
      if (!authStatus.authenticated) {
        clearSessionState();
        setLoading(false);
        return;
      }

      const [graphData, examplesData, settingsData, presetsRes, progressRes, dueRes, cardsRes] =
        await Promise.all([
          api.getGraph(),
          api.getExamples(),
          api.getSettings(),
          api.getPresets(),
          api.getProgress(),
          api.getDueCards(undefined, 1),
          api.getSrsCards(),
        ]);

      settingsRef.current = settingsData;
      sandboxConfigRef.current = settingsData.sandbox;
      setDataset(graphData);
      setExamples(examplesData);
      setSettings(settingsData);
      setSandboxConfig(settingsData.sandbox);
      setPresets(presetsRes.presets);
      setProgress(progressRes.items);
      setDueCount(dueRes.dueCount);
      setEnrolledNodeIds(new Set(cardsRes.cards.map((c) => c.node_id)));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearSessionState();
        setAuth((prev) =>
          prev
            ? { ...prev, authenticated: false }
            : { authDisabled: false, configured: true, authenticated: false }
        );
      } else {
        setLoadError(err instanceof Error ? err.message : "Failed to load application data");
      }
    } finally {
      setLoading(false);
    }
  }, [clearSessionState]);

  useEffect(() => {
    void refreshAuthAndData();
  }, [refreshAuthAndData]);

  const rawProjection = useMemo(() => (dataset ? projectGraph(dataset, false) : null), [dataset]);
  const mergedProjection = useMemo(() => (dataset ? projectGraph(dataset, true) : null), [dataset]);
  const projected = sandboxConfig.mergeVariants ? mergedProjection : rawProjection;

  const { knownIds, ignoredIds, learningIds } = useMemo(() => {
    const known = new Set<string>();
    const ignored = new Set<string>();
    const learning = new Set<string>();
    for (const [id, entry] of Object.entries(progress)) {
      if (entry.status === "known") known.add(id);
      else if (entry.status === "ignored") ignored.add(id);
      else if (entry.status === "learning") learning.add(id);
    }
    return { knownIds: known, ignoredIds: ignored, learningIds: learning };
  }, [progress]);

  const scoreResult = useMemo(() => {
    if (!projected) return null;
    return scoreGraph(projected, sandboxConfig, knownIds);
  }, [projected, sandboxConfig, knownIds]);

  const coverageSummary = useMemo(() => {
    if (!projected) return null;
    return computeKnownCoverage(projected, knownIds);
  }, [projected, knownIds]);

  const openInExplorer = useCallback(
    (id: string) => {
      if (projected) {
        const idx = resolveNodeIndex(projected, id);
        setSelectedNodeId(idx !== undefined ? projected.nodes[idx]!.id : id);
      } else {
        setSelectedNodeId(id);
      }
      setActiveTab("explorer");
    },
    [projected]
  );

  // Keep server's mergeVariants aligned before mutating a node if user flipped the UI toggle locally
  const ensureServerMergeModeAligned = useCallback(async () => {
    const uiMerge = sandboxConfigRef.current.mergeVariants;
    if (uiMerge !== settingsRef.current.sandbox.mergeVariants) {
      const synced = await api.updateSettings({ sandbox: { mergeVariants: uiMerge } });
      settingsRef.current = synced;
      setSettings(synced);
    }
  }, []);

  const updateNodeProgress = useCallback(
    async (nodeId: string, patch: { status?: NodeStatus; notes?: string }) => {
      await ensureServerMergeModeAligned();
      const updated = await api.updateProgress(nodeId, patch);
      setProgress((prev) => ({
        ...prev,
        [updated.nodeId]: {
          status: updated.status,
          source: updated.source,
          notes: updated.notes,
          updatedAt: updated.updatedAt,
        },
      }));
    },
    [ensureServerMergeModeAligned]
  );

  const bulkImportProgress = useCallback(
    async (payload: Parameters<typeof api.bulkImportProgress>[0]) => {
      await ensureServerMergeModeAligned();
      const res = await api.bulkImportProgress(payload);
      await refreshDueAndCards();
      return res;
    },
    [ensureServerMergeModeAligned, refreshDueAndCards]
  );

  const enrollNodes = useCallback(
    async (nodeIds: string[]) => {
      await ensureServerMergeModeAligned();
      const res = await api.enrollNodes(nodeIds);
      await refreshDueAndCards();
      return res;
    },
    [ensureServerMergeModeAligned, refreshDueAndCards]
  );

  const unenrollNode = useCallback(
    async (nodeId: string) => {
      await ensureServerMergeModeAligned();
      await api.unenrollNode(nodeId);
      await refreshDueAndCards();
    },
    [ensureServerMergeModeAligned, refreshDueAndCards]
  );

  const saveSettings = useCallback(
    async (patch: { sandbox?: Partial<SandboxConfig>; srs?: Partial<SrsSettings> }) => {
      const next = await api.updateSettings(patch);
      settingsRef.current = next;
      setSettings(next);
      if (patch.sandbox) {
        setSandboxConfig(next.sandbox);
      }
      await refreshDueAndCards();
    },
    [refreshDueAndCards]
  );

  const savePreset = useCallback(async (name: string) => {
    const created = await api.createPreset(name, sandboxConfigRef.current);
    setPresets((prev) => [created, ...prev]);
  }, []);

  const deletePreset = useCallback(async (id: string) => {
    await api.deletePreset(id);
    setPresets((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const restoreBackup = useCallback(
    async (json: unknown) => {
      const res = await api.importBackup(json);
      await refreshAuthAndData();
      return res;
    },
    [refreshAuthAndData]
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // Even if session already expired or network failed, always lock the local UI
    } finally {
      clearSessionState();
      setAuth((prev) =>
        prev
          ? { ...prev, authenticated: false }
          : { authDisabled: false, configured: true, authenticated: false }
      );
    }
  }, [clearSessionState]);

  return (
    <AppStateContext.Provider
      value={{
        auth,
        loading,
        loadError,
        activeTab,
        setActiveTab,
        dataset,
        examples,
        projected,
        sandboxConfig,
        setSandboxConfig,
        settings,
        presets,
        progress,
        knownIds,
        ignoredIds,
        learningIds,
        enrolledNodeIds,
        scoreResult,
        coverageSummary,
        dueCount,
        selectedNodeId,
        setSelectedNodeId,
        openInExplorer,
        refreshAuthAndData,
        refreshDueAndCards,
        updateNodeProgress,
        bulkImportProgress,
        enrollNodes,
        unenrollNode,
        ensureServerMergeModeAligned,
        saveSettings,
        savePreset,
        deletePreset,
        restoreBackup,
        logout,
      }}
    >
      {children}
    </AppStateContext.Provider>
  );
}

export function useAppState(): AppStateContextValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error("useAppState must be used inside AppStateProvider");
  return ctx;
}

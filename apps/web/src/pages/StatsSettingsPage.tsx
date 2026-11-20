import {
  Check,
  Download,
  KeyRound,
  RefreshCw,
  Save,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type CardType, type SrsSettings, type SrsStatsPayload } from "../api/client.js";
import { useAppState } from "../hooks/useAppState.js";
import {
  buildHeatmapGrid,
  fillForecast14d,
  triggerBlobDownload,
  type HeatmapDayCell,
} from "../utils/pinyinMatch.js";

const DRILL_MODE_META: Array<{ key: CardType; label: string; desc: string }> = [
  { key: "recognition", label: "Recognition", desc: "Character → Pinyin & English meaning" },
  { key: "stroke", label: "Stroke Drawing", desc: "Interactive offline stroke-order writing quiz" },
  { key: "component", label: "Component Breakdown", desc: "Identify direct building blocks of compounds" },
  { key: "listening", label: "Listening & Tone", desc: "Offline syllable MP3 + homophone context clue" },
];

const MAX_BACKUP_BYTES = 20 * 1024 * 1024;

interface ParsedBackupPreview {
  raw: unknown;
  fileName: string;
  progressCount: number;
  cardCount: number;
  logCount: number;
  exportedAt: string | null;
}

function heatmapFill(count: number): string {
  if (count <= 0) return "#ede7da";
  if (count <= 5) return "#b7d9cd";
  if (count <= 15) return "#6db59d";
  if (count <= 30) return "#369176";
  return "#1f745e";
}

export function StatsSettingsPage() {
  const {
    auth,
    settings,
    saveSettings,
    restoreBackup,
    ensureServerMergeModeAligned,
  } = useAppState();

  const [stats, setStats] = useState<SrsStatsPayload | null>(null);
  const [loadingStats, setLoadingStats] = useState(true);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [hoveredDay, setHoveredDay] = useState<HeatmapDayCell | null>(null);
  const [hoveredForecast, setHoveredForecast] = useState<{ date: string; label: string; count: number } | null>(null);

  // SRS Preferences draft
  const [srsDraft, setSrsDraft] = useState<SrsSettings>(settings.srs);
  const [dailyNewInput, setDailyNewInput] = useState(String(settings.srs.dailyNewLimit));
  const [masteryDaysInput, setMasteryDaysInput] = useState(String(settings.srs.masteryStabilityDays));
  const [savingSrs, setSavingSrs] = useState(false);
  const [srsMsg, setSrsMsg] = useState<string | null>(null);
  const [srsError, setSrsError] = useState<string | null>(null);

  // Backup / Restore state
  const [downloadingBackup, setDownloadingBackup] = useState(false);
  const [backupPreview, setBackupPreview] = useState<ParsedBackupPreview | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const backupInputRef = useRef<HTMLInputElement | null>(null);

  // Change Passphrase state
  const [currentPassphrase, setCurrentPassphrase] = useState("");
  const [newPassphrase, setNewPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [changingPass, setChangingPass] = useState(false);
  const [passMsg, setPassMsg] = useState<string | null>(null);
  const [passError, setPassError] = useState<string | null>(null);

  const statsSeqRef = useRef(0);

  useEffect(() => {
    setSrsDraft(settings.srs);
    setDailyNewInput(String(settings.srs.dailyNewLimit));
    setMasteryDaysInput(String(settings.srs.masteryStabilityDays));
  }, [settings.srs]);

  const loadStats = useCallback(async () => {
    const seq = ++statsSeqRef.current;
    setLoadingStats(true);
    setStatsError(null);
    try {
      await ensureServerMergeModeAligned();
      const data = await api.getSrsStats();
      if (seq === statsSeqRef.current) setStats(data);
    } catch (err) {
      if (seq === statsSeqRef.current) {
        setStatsError(err instanceof Error ? err.message : "Could not load learning analytics.");
      }
    } finally {
      if (seq === statsSeqRef.current) setLoadingStats(false);
    }
  }, [ensureServerMergeModeAligned]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  const heatmapCells = useMemo(
    () => (stats ? buildHeatmapGrid(stats.heatmap) : []),
    [stats]
  );

  const forecastSeries = useMemo(
    () => (stats ? fillForecast14d(stats.forecast14d) : []),
    [stats]
  );

  const maxForecastCount = useMemo(
    () => Math.max(4, ...forecastSeries.map((d) => d.count)),
    [forecastSeries]
  );

  const enabledModeCount = useMemo(
    () => Object.values(srsDraft.enabledModes).filter(Boolean).length,
    [srsDraft.enabledModes]
  );

  const toggleDrillMode = (mode: CardType) => {
    setSrsError(null);
    setSrsMsg(null);
    const nextVal = !srsDraft.enabledModes[mode];
    const nextModes = { ...srsDraft.enabledModes, [mode]: nextVal };
    if (!Object.values(nextModes).some(Boolean)) {
      setSrsError("Keep at least one review drill mode enabled.");
      return;
    }
    setSrsDraft((prev) => ({ ...prev, enabledModes: { ...prev.enabledModes, [mode]: nextVal } }));
  };

  const handleSaveSrs = async (e: React.FormEvent) => {
    e.preventDefault();
    if (enabledModeCount === 0) {
      setSrsError("Keep at least one review drill mode enabled.");
      return;
    }
    const parsedDaily = Number.parseInt(dailyNewInput, 10);
    const parsedMastery = Number.parseFloat(masteryDaysInput);
    if (!Number.isFinite(parsedDaily) || parsedDaily < 1 || parsedDaily > 200) {
      setSrsError("Daily new limit must be between 1 and 200.");
      return;
    }
    if (!Number.isFinite(parsedMastery) || parsedMastery < 0.5 || parsedMastery > 365) {
      setSrsError("Auto-Known stability threshold must be between 0.5 and 365 days.");
      return;
    }

    const payload: SrsSettings = {
      ...srsDraft,
      dailyNewLimit: parsedDaily,
      masteryStabilityDays: parsedMastery,
    };

    setSavingSrs(true);
    setSrsError(null);
    setSrsMsg(null);
    try {
      await saveSettings({ srs: payload });
      setSrsMsg("FSRS preferences saved.");
      await loadStats();
    } catch (err) {
      setSrsError(err instanceof Error ? err.message : "Could not save SRS preferences.");
    } finally {
      setSavingSrs(false);
    }
  };

  const handleDownloadBackup = async () => {
    setDownloadingBackup(true);
    setBackupError(null);
    setBackupMsg(null);
    try {
      const blob = await api.downloadBackup();
      const dateStr = new Date().toISOString().slice(0, 10);
      triggerBlobDownload(blob, `fuluoxiaojie-backup-${dateStr}.json`);
      setBackupMsg("Backup downloaded cleanly.");
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : "Failed to export backup.");
    } finally {
      setDownloadingBackup(false);
    }
  };

  const handleSelectBackupFile = async (file: File | null) => {
    setBackupError(null);
    setBackupMsg(null);
    setBackupPreview(null);
    try {
      if (!file) return;
      if (file.size > MAX_BACKUP_BYTES) {
        setBackupError("Backup file exceeds the 20 MB limit.");
        return;
      }
      const text = await file.text();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !Array.isArray(parsed.progress) ||
        !Array.isArray(parsed.srsCards)
      ) {
        setBackupError("Selected JSON file does not look like a FuLuoXiaoJie backup archive.");
        return;
      }
      setBackupPreview({
        raw: parsed,
        fileName: file.name,
        progressCount: parsed.progress.length,
        cardCount: parsed.srsCards.length,
        logCount: Array.isArray(parsed.reviewLogs) ? parsed.reviewLogs.length : 0,
        exportedAt: typeof parsed.exportedAt === "string" ? parsed.exportedAt : null,
      });
    } catch {
      setBackupError("Could not parse the selected file as valid JSON.");
    } finally {
      if (backupInputRef.current) backupInputRef.current.value = "";
    }
  };

  const handleConfirmRestore = async () => {
    if (!backupPreview) return;
    setRestoring(true);
    setBackupError(null);
    setBackupMsg(null);
    try {
      const res = await restoreBackup(backupPreview.raw);
      setBackupPreview(null);
      setBackupMsg(
        `Restored ${res.restoredProgress} progress entries, ${res.restoredCards} SRS cards, and ${res.restoredLogs} review logs.`
      );
      await loadStats();
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : "Failed to restore backup archive.");
    } finally {
      setRestoring(false);
    }
  };

  const handleChangePassphrase = async (e: React.FormEvent) => {
    e.preventDefault();
    setPassError(null);
    setPassMsg(null);

    if (newPassphrase.length < 8) {
      setPassError("New passphrase must be at least 8 characters.");
      return;
    }
    if (newPassphrase !== confirmPassphrase) {
      setPassError("New passphrase and confirmation do not match.");
      return;
    }

    setChangingPass(true);
    try {
      await api.changePassphrase(currentPassphrase, newPassphrase);
      setCurrentPassphrase("");
      setNewPassphrase("");
      setConfirmPassphrase("");
      setPassMsg("Passphrase updated. All other active sessions have been signed out.");
    } catch (err) {
      setPassError(err instanceof Error ? err.message : "Could not update passphrase.");
    } finally {
      setChangingPass(false);
    }
  };

  const weekCount = heatmapCells.length > 0 ? heatmapCells[heatmapCells.length - 1]!.weekIndex + 1 : 13;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Section 1: Learning Analytics & Coverage */}
      <section className="panel" aria-label="Learning progress and coverage analytics">
        <div className="panel-header">
          <div>
            <h1 className="panel-title">Progress &amp; FSRS Analytics</h1>
            <div style={{ fontSize: 12, color: "var(--ink-muted)", marginTop: 2 }}>
              Corpus comprehension, HSK 3.0 progress, review consistency, and 14-day workload forecast.
            </div>
          </div>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={loadingStats}
            onClick={() => void loadStats()}
          >
            <RefreshCw size={13} /> Refresh
          </button>
        </div>

        <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {statsError && (
            <div className="alert-error" role="alert">
              {statsError}
            </div>
          )}

          {loadingStats && !stats ? (
            <div style={{ color: "var(--ink-muted)", fontSize: 13 }}>Loading analytics...</div>
          ) : stats ? (
            <>
              {/* KPI Strip */}
              <div className="kpi-grid">
                <div className="kpi-card">
                  <div className="metric-label">Known Characters</div>
                  <div className="kpi-value mono">{stats.coverage.knownChars.toLocaleString()}</div>
                  <div className="kpi-sub">
                    of {stats.coverage.totalChars.toLocaleString()} · {stats.learningNodes} learning
                  </div>
                </div>
                <div className="kpi-card">
                  <div className="metric-label">Spoken SUBTLEX Coverage</div>
                  <div className="kpi-value mono" style={{ color: "var(--jade)" }}>
                    {stats.coverage.subtlexCoveragePct.toFixed(2)}%
                  </div>
                  <div className="kpi-sub">Subtitle &amp; conversational Mandarin</div>
                </div>
                <div className="kpi-card">
                  <div className="metric-label">Written Jun Da Coverage</div>
                  <div className="kpi-value mono" style={{ color: "var(--slate)" }}>
                    {stats.coverage.jundaCoveragePct.toFixed(2)}%
                  </div>
                  <div className="kpi-sub">Modern written Chinese corpus</div>
                </div>
                <div className="kpi-card">
                  <div className="metric-label">Due Now</div>
                  <div className="kpi-value mono" style={{ color: stats.dueNow > 0 ? "var(--vermilion)" : "var(--jade)" }}>
                    {stats.dueNow}
                  </div>
                  <div className="kpi-sub">Active enabled drill modes</div>
                </div>
                <div className="kpi-card">
                  <div className="metric-label">30-Day Retention</div>
                  <div className="kpi-value mono">
                    {stats.retentionRate30dPct !== null ? `${stats.retentionRate30dPct.toFixed(1)}%` : "—"}
                  </div>
                  <div className="kpi-sub">Target {Math.round(settings.srs.requestRetention * 100)}%</div>
                </div>
                <div className="kpi-card">
                  <div className="metric-label">Reviews (Today / Total)</div>
                  <div className="kpi-value mono">
                    {stats.todayReviews} / {stats.totalReviews.toLocaleString()}
                  </div>
                  <div className="kpi-sub">Logged in SQLite history</div>
                </div>
              </div>

              {/* HSK 3.0 Mastery Bars */}
              <div>
                <h2 className="section-heading">HSK 3.0 Band Mastery</h2>
                <div className="hsk-bars-grid">
                  {Object.entries(stats.coverage.hskCoverage)
                    .map(([lvl, band]) => ({ level: Number(lvl), known: band.known, total: band.total }))
                    .sort((a, b) => a.level - b.level)
                    .map((band) => {
                      const pct = band.total > 0 ? (band.known / band.total) * 100 : 0;
                      return (
                        <div key={band.level} className="hsk-bar-row">
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
                            <strong>HSK {band.level === 7 ? "7–9" : band.level}</strong>
                            <span className="mono" style={{ color: "var(--ink-secondary)" }}>
                              {band.known} / {band.total} ({pct.toFixed(0)}%)
                            </span>
                          </div>
                          <div className="progress-track">
                            <div className="progress-fill" style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>

              {/* Heatmap + 14-Day Forecast Charts */}
              <div className="charts-grid">
                {/* 90-Day Review Activity Heatmap */}
                <div className="panel" style={{ boxShadow: "none" }}>
                  <div className="panel-header" style={{ padding: "10px 14px" }}>
                    <h2 className="panel-title">90-Day Review Activity</h2>
                    <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                      {hoveredDay
                        ? `${hoveredDay.date}: ${hoveredDay.count} rev${hoveredDay.againCount > 0 ? ` (${hoveredDay.againCount} Again)` : ""}`
                        : "Hover a day"}
                    </span>
                  </div>
                  <div className="panel-body" style={{ padding: 14 }}>
                    <svg
                      viewBox={`0 0 ${weekCount * 18 + 34} 138`}
                      style={{ width: "100%", height: "auto", display: "block" }}
                      role="img"
                      aria-label="90-day review activity heatmap"
                    >
                      {["S", "M", "T", "W", "T", "F", "S"].map((lbl, dow) =>
                        dow % 2 === 1 ? (
                          <text
                            key={dow}
                            x={8}
                            y={18 + dow * 16 + 10}
                            fontSize={9.5}
                            fill="#787b82"
                            fontFamily="JetBrains Mono, monospace"
                          >
                            {lbl}
                          </text>
                        ) : null
                      )}

                      {heatmapCells.map((cell) => {
                        const x = 24 + cell.weekIndex * 18;
                        const y = 14 + cell.dayOfWeek * 16;
                        const isHovered = hoveredDay?.date === cell.date;
                        return (
                          <rect
                            key={cell.date}
                            x={x}
                            y={y}
                            width={13}
                            height={13}
                            rx={3}
                            fill={heatmapFill(cell.count)}
                            stroke={isHovered ? "#1a1c20" : "rgba(26,28,32,0.06)"}
                            strokeWidth={isHovered ? 1.5 : 1}
                            onMouseEnter={() => setHoveredDay(cell)}
                            onMouseLeave={() => setHoveredDay(null)}
                          >
                            <title>{`${cell.date}: ${cell.count} reviews`}</title>
                          </rect>
                        );
                      })}
                    </svg>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "flex-end",
                        gap: 5,
                        marginTop: 8,
                        fontSize: 11,
                        color: "var(--ink-muted)",
                      }}
                    >
                      <span>Less</span>
                      {[0, 3, 10, 20, 40].map((v) => (
                        <span
                          key={v}
                          style={{
                            width: 11,
                            height: 11,
                            borderRadius: 2,
                            background: heatmapFill(v),
                            display: "inline-block",
                            border: "1px solid rgba(26,28,32,0.08)",
                          }}
                        />
                      ))}
                      <span>More</span>
                    </div>
                  </div>
                </div>

                {/* 14-Day Due Forecast + Card States */}
                <div className="panel" style={{ boxShadow: "none" }}>
                  <div className="panel-header" style={{ padding: "10px 14px" }}>
                    <h2 className="panel-title">14-Day Due Forecast</h2>
                    <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                      {hoveredForecast
                        ? `${hoveredForecast.date}: ${hoveredForecast.count} due`
                        : "UTC schedule"}
                    </span>
                  </div>
                  <div className="panel-body" style={{ padding: 14 }}>
                    <svg
                      viewBox="0 0 420 148"
                      style={{ width: "100%", height: "auto", display: "block" }}
                      role="img"
                      aria-label="14-day upcoming due card forecast"
                    >
                      <line x1={12} y1={118} x2={408} y2={118} stroke="#cfc4b0" strokeWidth={1} />
                      {forecastSeries.map((day, i) => {
                        const slotW = 392 / 14;
                        const barW = 18;
                        const x = 14 + i * slotW + (slotW - barW) / 2;
                        const barH = Math.round((day.count / maxForecastCount) * 94);
                        const y = 118 - barH;
                        const active = hoveredForecast?.date === day.date;
                        return (
                          <g
                            key={day.date}
                            onMouseEnter={() => setHoveredForecast(day)}
                            onMouseLeave={() => setHoveredForecast(null)}
                          >
                            <rect
                              x={14 + i * slotW}
                              y={12}
                              width={slotW}
                              height={126}
                              fill="transparent"
                            />
                            <rect
                              x={x}
                              y={Math.min(116, y)}
                              width={barW}
                              height={day.count > 0 ? Math.max(3, barH) : 2}
                              rx={3}
                              fill={
                                day.count === 0
                                  ? "#e2dacb"
                                  : i === 0
                                    ? "#b93a2b"
                                    : active
                                      ? "#1f745e"
                                      : "#35598a"
                              }
                            >
                              <title>{`${day.date}: ${day.count} due`}</title>
                            </rect>
                            {day.count > 0 && (
                              <text
                                x={x + barW / 2}
                                y={Math.max(12, y - 4)}
                                textAnchor="middle"
                                fontSize={9.5}
                                fill="#4c5059"
                                fontFamily="JetBrains Mono, monospace"
                              >
                                {day.count}
                              </text>
                            )}
                            {(i === 0 || i === 4 || i === 9 || i === 13) && (
                              <text
                                x={x + barW / 2}
                                y={134}
                                textAnchor="middle"
                                fontSize={9.5}
                                fill="#787b82"
                                fontFamily="JetBrains Mono, monospace"
                              >
                                {day.label}
                              </text>
                            )}
                          </g>
                        );
                      })}
                    </svg>

                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
                      <span className="chip chip-stone mono">New: {stats.cardStates.new}</span>
                      <span className="chip chip-ochre mono">Learning: {stats.cardStates.learning}</span>
                      <span className="chip chip-jade mono">Review: {stats.cardStates.review}</span>
                      <span className="chip chip-vermilion mono">Relearning: {stats.cardStates.relearning}</span>
                    </div>
                  </div>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </section>

      {/* Section 2 & 3: Settings + Backup & Security */}
      <div className="settings-two-col">
        {/* SRS Preferences */}
        <section className="panel" aria-label="FSRS study preferences">
          <div className="panel-header">
            <h2 className="panel-title">FSRS &amp; Drill Preferences</h2>
          </div>
          <form className="panel-body" onSubmit={(e) => void handleSaveSrs(e)} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(155px, 1fr))", gap: 12 }}>
              <div>
                <label className="field-label" htmlFor="srs-daily-new">
                  Daily New Limit
                </label>
                <input
                  id="srs-daily-new"
                  type="number"
                  className="input mono"
                  min={1}
                  max={200}
                  value={dailyNewInput}
                  onChange={(e) => setDailyNewInput(e.target.value)}
                />
              </div>

              <div>
                <label className="field-label" htmlFor="srs-mastery-days">
                  Auto-Known Stability (days)
                </label>
                <input
                  id="srs-mastery-days"
                  type="number"
                  className="input mono"
                  min={0.5}
                  max={365}
                  step="any"
                  value={masteryDaysInput}
                  onChange={(e) => setMasteryDaysInput(e.target.value)}
                />
              </div>
            </div>

            <div className="slider-group">
              <div className="slider-label">
                <span>FSRS Target Retention</span>
                <span className="mono">{Math.round(srsDraft.requestRetention * 100)}%</span>
              </div>
              <input
                type="range"
                aria-label="FSRS target retention"
                min={0.7}
                max={0.97}
                step={0.01}
                value={srsDraft.requestRetention}
                onChange={(e) =>
                  setSrsDraft((prev) => ({
                    ...prev,
                    requestRetention: Number(e.target.value),
                  }))
                }
              />
              <span style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                90% is optimal for most Mandarin learners; higher targets schedule more frequent reviews.
              </span>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 9, paddingTop: 4, borderTop: "1px solid var(--border)" }}>
              <span className="field-label" style={{ marginBottom: 0 }}>
                Enabled Review Drill Modes
              </span>
              {DRILL_MODE_META.map((m) => (
                <label key={m.key} className="toggle-row" htmlFor={`mode-switch-${m.key}`}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 550 }}>{m.label}</div>
                    <div style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>{m.desc}</div>
                  </div>
                  <button
                    id={`mode-switch-${m.key}`}
                    type="button"
                    role="switch"
                    aria-checked={srsDraft.enabledModes[m.key]}
                    aria-label={`Enable ${m.label} drill mode`}
                    className="switch"
                    onClick={() => toggleDrillMode(m.key)}
                  />
                </label>
              ))}
            </div>

            <div style={{ paddingTop: 8, borderTop: "1px solid var(--border)" }}>
              <label className="toggle-row" htmlFor="toggle-typing-rec">
                <div>
                  <div style={{ fontSize: 13, fontWeight: 550 }}>Pinyin typing in Recognition drills</div>
                  <div style={{ fontSize: 11.5, color: "var(--ink-muted)" }}>
                    Verify tone-marked or numbered pinyin before revealing the card.
                  </div>
                </div>
                <button
                  id="toggle-typing-rec"
                  type="button"
                  role="switch"
                  aria-checked={srsDraft.enableTypingInRecognition}
                  aria-label="Enable pinyin typing in recognition drills"
                  className="switch"
                  onClick={() =>
                    setSrsDraft((prev) => ({
                      ...prev,
                      enableTypingInRecognition: !prev.enableTypingInRecognition,
                    }))
                  }
                />
              </label>
            </div>

            {srsError && (
              <div className="alert-error" role="alert">
                {srsError}
              </div>
            )}
            {srsMsg && (
              <div className="alert-success" role="status">
                <Check size={14} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                {srsMsg}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="submit" className="btn btn-primary" disabled={savingSrs}>
                <Save size={14} /> {savingSrs ? "Saving..." : "Save Preferences"}
              </button>
            </div>
          </form>
        </section>

        {/* Backup, Restore & Passphrase Security */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <section className="panel" aria-label="Backup and restore">
            <div className="panel-header">
              <h2 className="panel-title">SQLite Data Backup &amp; Restore</h2>
            </div>
            <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <p style={{ margin: 0, fontSize: 13, color: "var(--ink-secondary)" }}>
                Export a complete portable JSON archive of your progress, mnemonic notes, FSRS cards,
                review history, and saved sandbox presets. Great for Raspberry Pi SD-card backups.
              </p>

              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={downloadingBackup}
                  onClick={() => void handleDownloadBackup()}
                >
                  <Download size={14} />
                  {downloadingBackup ? "Exporting..." : "Download JSON Backup"}
                </button>

                <input
                  ref={backupInputRef}
                  type="file"
                  accept="application/json,.json"
                  style={{ display: "none" }}
                  onChange={(e) => void handleSelectBackupFile(e.target.files?.[0] ?? null)}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={restoring}
                  onClick={() => backupInputRef.current?.click()}
                >
                  <Upload size={14} /> Restore from JSON...
                </button>
              </div>

              {backupPreview && (
                <div
                  style={{
                    padding: 12,
                    borderRadius: "var(--radius-sm)",
                    background: "var(--bg-paper)",
                    border: "1px solid var(--border-strong)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 650 }}>
                    Ready to restore <span className="mono">{backupPreview.fileName}</span>
                  </div>
                  <div className="mono" style={{ fontSize: 12, color: "var(--ink-secondary)" }}>
                    {backupPreview.progressCount} progress rows · {backupPreview.cardCount} SRS cards ·{" "}
                    {backupPreview.logCount} review logs
                  </div>
                  <div style={{ fontSize: 12, color: "var(--vermilion)", fontWeight: 550 }}>
                    Warning: Restoring replaces all current progress, SRS cards, and review logs.
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={restoring}
                      onClick={() => void handleConfirmRestore()}
                    >
                      {restoring ? "Restoring..." : "Confirm Restore"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={restoring}
                      onClick={() => setBackupPreview(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {backupError && (
                <div className="alert-error" role="alert">
                  {backupError}
                </div>
              )}
              {backupMsg && (
                <div className="alert-success" role="status">
                  {backupMsg}
                </div>
              )}
            </div>
          </section>

          {/* Security / Passphrase Rotation */}
          <section className="panel" aria-label="Security settings">
            <div className="panel-header">
              <h2 className="panel-title" style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                <ShieldCheck size={16} style={{ color: "var(--jade)" }} />
                Passphrase &amp; Session Security
              </h2>
            </div>
            <div className="panel-body">
              {auth?.authDisabled ? (
                <div style={{ fontSize: 13, color: "var(--ink-secondary)" }}>
                  Passphrase authentication is currently disabled via{" "}
                  <code className="mono">DISABLE_AUTH=true</code>. Keep this instance strictly on a
                  private local network or behind a Zero Trust proxy.
                </div>
              ) : (
                <form
                  onSubmit={(e) => void handleChangePassphrase(e)}
                  style={{ display: "flex", flexDirection: "column", gap: 11 }}
                >
                  <div>
                    <label className="field-label" htmlFor="sec-current-pass">
                      Current Passphrase
                    </label>
                    <input
                      id="sec-current-pass"
                      type="password"
                      className="input"
                      autoComplete="current-password"
                      value={currentPassphrase}
                      onChange={(e) => setCurrentPassphrase(e.target.value)}
                      required
                    />
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(155px, 1fr))", gap: 10 }}>
                    <div>
                      <label className="field-label" htmlFor="sec-new-pass">
                        New Passphrase (min 8 chars)
                      </label>
                      <input
                        id="sec-new-pass"
                        type="password"
                        className="input"
                        autoComplete="new-password"
                        minLength={8}
                        value={newPassphrase}
                        onChange={(e) => setNewPassphrase(e.target.value)}
                        required
                      />
                    </div>
                    <div>
                      <label className="field-label" htmlFor="sec-confirm-pass">
                        Confirm New Passphrase
                      </label>
                      <input
                        id="sec-confirm-pass"
                        type="password"
                        className="input"
                        autoComplete="new-password"
                        minLength={8}
                        value={confirmPassphrase}
                        onChange={(e) => setConfirmPassphrase(e.target.value)}
                        required
                      />
                    </div>
                  </div>

                  {passError && (
                    <div className="alert-error" role="alert">
                      {passError}
                    </div>
                  )}
                  {passMsg && (
                    <div className="alert-success" role="status">
                      {passMsg}
                    </div>
                  )}

                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <button
                      type="submit"
                      className="btn btn-primary"
                      disabled={changingPass || !currentPassphrase || !newPassphrase}
                    >
                      <KeyRound size={14} /> {changingPass ? "Updating..." : "Update Passphrase"}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

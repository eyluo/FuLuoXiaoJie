import { CheckCircle2, ListChecks, RefreshCw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type CardType, type DueCardPayload } from "../api/client.js";
import { ComponentDrill } from "../components/drills/ComponentDrill.js";
import { ListeningDrill } from "../components/drills/ListeningDrill.js";
import { RecognitionDrill } from "../components/drills/RecognitionDrill.js";
import { StrokeDrill } from "../components/drills/StrokeDrill.js";
import { useAppState } from "../hooks/useAppState.js";
import { useMandarinAudio } from "../hooks/useAudio.js";

type ModeTab = "all" | CardType;

const MODE_TABS: Array<{ id: ModeTab; label: string }> = [
  { id: "all", label: "All Due" },
  { id: "recognition", label: "Recognition" },
  { id: "stroke", label: "Stroke" },
  { id: "component", label: "Component" },
  { id: "listening", label: "Listening" },
];

const RATING_CLASS: Record<1 | 2 | 3 | 4, string> = {
  1: "again",
  2: "hard",
  3: "good",
  4: "easy",
};

export function ReviewPage() {
  const {
    settings,
    enrolledNodeIds,
    setActiveTab,
    openInExplorer,
    refreshDueAndCards,
    ensureServerMergeModeAligned,
  } = useAppState();
  const { playSyllable, speakWord, stopActive } = useMandarinAudio();

  const [modeTab, setModeTab] = useState<ModeTab>("all");
  const [queue, setQueue] = useState<DueCardPayload[]>([]);
  const [totalDue, setTotalDue] = useState(0);
  const [sessionTotal, setSessionTotal] = useState(0);
  const [reviewedCount, setReviewedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [revealed, setRevealed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [promotionBanner, setPromotionBanner] = useState<string | null>(null);

  const fetchSeqRef = useRef(0);
  const submitSeqRef = useRef(0);
  const submittingRef = useRef(false);
  const cardShownAtRef = useRef(Date.now());
  const promoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (promoTimerRef.current) clearTimeout(promoTimerRef.current);
      stopActive();
    };
  }, [stopActive]);

  const loadDueQueue = useCallback(
    async (selectedMode: ModeTab, resetSessionCounter = true) => {
      const seq = ++fetchSeqRef.current;
      submittingRef.current = false;
      setSubmitting(false);
      setLoading(true);
      setErrorMsg(null);
      setRevealed(false);
      stopActive();

      try {
        await ensureServerMergeModeAligned();
        const res = await api.getDueCards(selectedMode === "all" ? undefined : selectedMode, 40);
        if (seq !== fetchSeqRef.current) return;
        setQueue(res.cards);
        setTotalDue(res.dueCount);
        if (resetSessionCounter) {
          setSessionTotal(res.dueCount);
          setReviewedCount(0);
        }
        cardShownAtRef.current = Date.now();
      } catch (err) {
        if (seq !== fetchSeqRef.current) return;
        setErrorMsg(err instanceof Error ? err.message : "Could not load due review cards.");
      } finally {
        if (seq === fetchSeqRef.current) setLoading(false);
      }
    },
    [ensureServerMergeModeAligned, stopActive]
  );

  useEffect(() => {
    void loadDueQueue(modeTab, true);
  }, [modeTab, loadDueQueue]);

  const activeCard = queue[0] ?? null;

  const handleReveal = useCallback(() => {
    setRevealed(true);
  }, []);

  const handleRate = useCallback(
    async (rating: 1 | 2 | 3 | 4) => {
      if (!activeCard || !revealed || submittingRef.current) return;
      submittingRef.current = true;
      const mySubmitSeq = ++submitSeqRef.current;
      const targetCard = activeCard;
      const reqSeq = fetchSeqRef.current;
      const durationMs = Math.min(600_000, Math.max(0, Date.now() - cardShownAtRef.current));

      setSubmitting(true);
      setErrorMsg(null);
      stopActive();

      try {
        const res = await api.submitReview(targetCard.card.id, rating, durationMs);
        if (res.promotedToKnown) {
          setPromotionBanner(
            `“${targetCard.node.id}” reached mastery stability and was promoted to Known!`
          );
          if (promoTimerRef.current) clearTimeout(promoTimerRef.current);
          promoTimerRef.current = setTimeout(() => setPromotionBanner(null), 4500);
        }

        // Sync global navbar due badge and progress state in background
        void refreshDueAndCards().catch(() => {});

        // If the user switched mode tabs while submitting, skip mutating the new tab's queue
        if (reqSeq !== fetchSeqRef.current) return;

        const nextQueue = queue.slice(1);
        setQueue(nextQueue);
        setTotalDue((prev) => Math.max(0, prev - 1));
        setReviewedCount((prev) => prev + 1);
        setRevealed(false);
        cardShownAtRef.current = Date.now();

        // If we finished the current batch, check if more due cards remain
        if (nextQueue.length === 0) {
          await loadDueQueue(modeTab, false);
        }
      } catch (err) {
        if (reqSeq === fetchSeqRef.current) {
          setErrorMsg(err instanceof Error ? err.message : "Failed to submit FSRS review.");
        }
      } finally {
        if (reqSeq === fetchSeqRef.current && mySubmitSeq === submitSeqRef.current) {
          submittingRef.current = false;
          setSubmitting(false);
        }
      }
    },
    [activeCard, revealed, stopActive, queue, refreshDueAndCards, loadDueQueue, modeTab]
  );

  // Keyboard shortcuts: Space reveals, 1-4 rates once revealed, R replays audio
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (!activeCard || loading) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable
      ) {
        return;
      }

      if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        if (activeCard.node.audio) {
          void playSyllable(activeCard.node.audio, activeCard.node.id);
        }
        return;
      }

      if (e.code === "Space" && !revealed && tag !== "BUTTON") {
        e.preventDefault();
        setRevealed(true);
        if (activeCard.card.card_type === "recognition" && activeCard.node.audio) {
          void playSyllable(activeCard.node.audio, activeCard.node.id);
        }
        return;
      }

      if (
        revealed &&
        !submittingRef.current &&
        (e.key === "1" || e.key === "2" || e.key === "3" || e.key === "4")
      ) {
        e.preventDefault();
        void handleRate(Number(e.key) as 1 | 2 | 3 | 4);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeCard, loading, revealed, playSyllable, handleRate]);

  const progressPct =
    sessionTotal > 0 ? Math.min(100, Math.round((reviewedCount / sessionTotal) * 100)) : 0;

  return (
    <div className="review-shell">
      {/* Mode Filter & Session Header */}
      <div className="panel" style={{ marginBottom: 14 }}>
        <div
          className="panel-body"
          style={{ display: "flex", flexDirection: "column", gap: 10, padding: "12px 16px" }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <div className="segmented" role="tablist" aria-label="Review drill mode filter">
              {MODE_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={modeTab === tab.id}
                  className={modeTab === tab.id ? "active" : ""}
                  onClick={() => setModeTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={loading}
              onClick={() => void loadDueQueue(modeTab, true)}
              title="Refresh due queue"
            >
              <RefreshCw size={13} /> Refresh
            </button>
          </div>

          {/* Progress Bar */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 8,
              fontSize: 12,
            }}
          >
            <span style={{ color: "var(--ink-secondary)" }}>
              {reviewedCount > 0 ? (
                <>
                  Reviewed <strong className="mono">{reviewedCount}</strong> this session ·{" "}
                </>
              ) : null}
              <strong className="mono">{totalDue}</strong> due {modeTab === "all" ? "across active modes" : `in ${modeTab}`}
            </span>
            <span style={{ color: "var(--ink-muted)" }}>
              <kbd className="kbd">Space</kbd> reveal · <kbd className="kbd">1–4</kbd> rate · <kbd className="kbd">R</kbd> audio
            </span>
          </div>
          <div className="progress-track" aria-hidden="true">
            <div className="progress-fill" style={{ width: `${progressPct}%` }} />
          </div>
        </div>
      </div>

      {/* Mastery Promotion Toast */}
      {promotionBanner && (
        <div className="alert-success" role="status" style={{ marginBottom: 14, display: "flex", alignItems: "center", gap: 8 }}>
          <Sparkles size={16} />
          <span>{promotionBanner}</span>
        </div>
      )}

      {errorMsg && (
        <div className="alert-error" role="alert" style={{ marginBottom: 14 }}>
          {errorMsg}
        </div>
      )}

      {/* Main Card Surface */}
      {loading ? (
        <div className="review-card" style={{ padding: "48px 24px", color: "var(--ink-muted)" }}>
          Loading due FSRS cards...
        </div>
      ) : !activeCard ? (
        <div className="review-card" style={{ padding: "44px 28px" }}>
          <CheckCircle2 size={38} style={{ color: "var(--jade)", marginBottom: 10 }} />
          <h1 style={{ margin: "0 0 8px", fontSize: 20 }}>
            {enrolledNodeIds.size === 0
              ? "Your FSRS Deck Is Empty"
              : modeTab === "all"
                ? "All Caught Up!"
                : `No ${modeTab} Cards Due Right Now`}
          </h1>
          <p style={{ margin: "0 auto 20px", maxWidth: 440, color: "var(--ink-secondary)", fontSize: 13.5 }}>
            {enrolledNodeIds.size === 0
              ? "Enroll high-leverage characters from your Study Planner or DAG Explorer to start practicing recognition, stroke order, components, and listening."
              : reviewedCount > 0
                ? `Great session — you completed ${reviewedCount} review${reviewedCount === 1 ? "" : "s"}. FSRS will resurface each card right before you forget it.`
                : "Every card in this filter is scheduled for a future date. You can enroll fresh characters from your Study Planner whenever you're ready."}
          </p>
          <div style={{ display: "flex", justifyContent: "center", gap: 8, flexWrap: "wrap" }}>
            {modeTab !== "all" && (
              <button type="button" className="btn" onClick={() => setModeTab("all")}>
                Show All Due Modes
              </button>
            )}
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setActiveTab("planner")}
            >
              <ListChecks size={15} /> Go to Study Planner
            </button>
          </div>
        </div>
      ) : (
        <article className="review-card" aria-live="polite">
          {activeCard.card.card_type === "recognition" && (
            <RecognitionDrill
              key={activeCard.card.id}
              payload={activeCard}
              enableTyping={settings.srs.enableTypingInRecognition}
              revealed={revealed}
              onReveal={handleReveal}
              onPlaySyllable={(audio, fallback) => void playSyllable(audio, fallback)}
              onSpeakWord={speakWord}
              onInspectNode={openInExplorer}
            />
          )}

          {activeCard.card.card_type === "stroke" && (
            <StrokeDrill
              key={activeCard.card.id}
              payload={activeCard}
              revealed={revealed}
              onReveal={handleReveal}
              onPlaySyllable={(audio, fallback) => void playSyllable(audio, fallback)}
              onSpeakWord={speakWord}
              onInspectNode={openInExplorer}
            />
          )}

          {activeCard.card.card_type === "component" && (
            <ComponentDrill
              key={activeCard.card.id}
              payload={activeCard}
              revealed={revealed}
              onReveal={handleReveal}
              onPlaySyllable={(audio, fallback) => void playSyllable(audio, fallback)}
              onSpeakWord={speakWord}
              onInspectNode={openInExplorer}
            />
          )}

          {activeCard.card.card_type === "listening" && (
            <ListeningDrill
              key={activeCard.card.id}
              payload={activeCard}
              revealed={revealed}
              onReveal={handleReveal}
              onPlaySyllable={(audio, fallback) => void playSyllable(audio, fallback)}
              onSpeakWord={speakWord}
              onInspectNode={openInExplorer}
            />
          )}

          {/* 4-Button FSRS Rating Bar (shown once revealed) */}
          {revealed && (
            <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
              <div style={{ fontSize: 12, color: "var(--ink-muted)", marginBottom: 8 }}>
                How well did you recall this card? (Keys <kbd className="kbd">1</kbd>–<kbd className="kbd">4</kbd>)
              </div>
              <div className="rating-bar">
                {activeCard.previews.map((p) => (
                  <button
                    key={p.rating}
                    type="button"
                    className={`rating-btn ${RATING_CLASS[p.rating]}`}
                    disabled={submitting}
                    onClick={() => void handleRate(p.rating)}
                  >
                    <span style={{ fontWeight: 700, fontSize: 13.5 }}>
                      {p.rating}. {p.label}
                    </span>
                    <span className="mono" style={{ fontSize: 11.5, opacity: 0.85 }}>
                      {p.intervalLabel}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </article>
      )}
    </div>
  );
}

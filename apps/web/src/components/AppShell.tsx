import {
  BarChart3,
  BookOpen,
  GitBranch,
  GraduationCap,
  ListChecks,
  LogOut,
  Sliders,
} from "lucide-react";
import type { ReactNode } from "react";
import { useAppState, type AppTab } from "../hooks/useAppState.js";

interface NavItem {
  id: AppTab;
  label: string;
  shortLabel: string;
  icon: typeof GitBranch;
}

const NAV_ITEMS: NavItem[] = [
  { id: "explorer", label: "DAG Explorer", shortLabel: "DAG", icon: GitBranch },
  { id: "sandbox", label: "Algorithm Sandbox", shortLabel: "Sandbox", icon: Sliders },
  { id: "planner", label: "Study Planner", shortLabel: "Planner", icon: ListChecks },
  { id: "review", label: "SRS Review", shortLabel: "Review", icon: GraduationCap },
  { id: "stats", label: "Stats & Settings", shortLabel: "Stats", icon: BarChart3 },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { auth, activeTab, setActiveTab, coverageSummary, dueCount, logout } = useAppState();

  return (
    <div className="app-shell">
      <header className="topbar">
        <a
          className="brand"
          href="#explorer"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab("explorer");
          }}
        >
          <span className="seal-mark" aria-hidden="true">
            弗
          </span>
          <span className="brand-text">
            <span className="brand-title">弗洛小姐 · FuLuoXiaoJie</span>
            <span className="brand-sub">Simplified Mandarin DAG Studio</span>
          </span>
        </a>

        <nav className="nav-tabs" aria-label="Primary navigation">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                id={`nav-tab-${item.id}`}
                type="button"
                className={`nav-tab${isActive ? " active" : ""}`}
                onClick={() => setActiveTab(item.id)}
              >
                <Icon size={15} strokeWidth={1.8} />
                <span>{item.label}</span>
                {item.id === "review" && dueCount > 0 && (
                  <span className="nav-badge" aria-label={`${dueCount} due cards`}>
                    {dueCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="topbar-right">
          {coverageSummary && (
            <span
              className="coverage-pill mono"
              title={`${coverageSummary.knownChars} known characters covering ${coverageSummary.subtlexCoveragePct}% of spoken & ${coverageSummary.jundaCoveragePct}% of written Mandarin`}
            >
              <BookOpen size={13} />
              {coverageSummary.knownChars} chars · {coverageSummary.subtlexCoveragePct}%
            </span>
          )}
          {auth && !auth.authDisabled && (
            <button
              id="btn-logout"
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void logout()}
              title="Lock & sign out"
              aria-label="Lock and sign out"
            >
              <LogOut size={15} />
            </button>
          )}
        </div>
      </header>

      <main className="main-content">{children}</main>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              className={isActive ? "active" : ""}
              onClick={() => setActiveTab(item.id)}
            >
              <Icon size={17} strokeWidth={1.8} />
              <span>
                {item.shortLabel}
                {item.id === "review" && dueCount > 0 ? ` (${dueCount})` : ""}
              </span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

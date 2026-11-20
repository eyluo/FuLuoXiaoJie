import { AppShell } from "./components/AppShell.js";
import { AuthGate } from "./components/AuthGate.js";
import { AppStateProvider, useAppState } from "./hooks/useAppState.js";
import { ExplorerPage } from "./pages/ExplorerPage.js";
import { PlannerPage } from "./pages/PlannerPage.js";
import { ReviewPage } from "./pages/ReviewPage.js";
import { SandboxPage } from "./pages/SandboxPage.js";
import { StatsSettingsPage } from "./pages/StatsSettingsPage.js";

function WorkspaceRouter() {
  const { auth, loading, loadError, activeTab, refreshAuthAndData } = useAppState();

  if (loading && !auth) {
    return (
      <main className="auth-page">
        <div className="panel panel-body" style={{ textAlign: "center", padding: "28px 36px" }}>
          <div className="seal-mark" style={{ margin: "0 auto 12px" }}>
            弗
          </div>
          <div style={{ fontWeight: 600 }}>Loading 弗洛小姐 · FuLuoXiaoJie...</div>
        </div>
      </main>
    );
  }

  if (auth && !auth.authenticated) {
    return <AuthGate auth={auth} onAuthenticated={refreshAuthAndData} />;
  }

  if (loadError) {
    return (
      <main className="auth-page">
        <div className="auth-card">
          <div className="alert-error" style={{ marginBottom: 14 }}>
            {loadError}
          </div>
          <button type="button" className="btn btn-primary" onClick={() => void refreshAuthAndData()}>
            Retry
          </button>
        </div>
      </main>
    );
  }

  return (
    <AppShell>
      {activeTab === "explorer" && <ExplorerPage />}
      {activeTab === "sandbox" && <SandboxPage />}
      {activeTab === "planner" && <PlannerPage />}
      {activeTab === "review" && <ReviewPage />}
      {activeTab === "stats" && <StatsSettingsPage />}
    </AppShell>
  );
}

export function App() {
  return (
    <AppStateProvider>
      <WorkspaceRouter />
    </AppStateProvider>
  );
}

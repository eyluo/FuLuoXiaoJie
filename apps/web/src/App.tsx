import { AppShell } from "./components/AppShell.js";
import { AuthGate } from "./components/AuthGate.js";
import { AppStateProvider, useAppState } from "./hooks/useAppState.js";
import { ExplorerPage } from "./pages/ExplorerPage.js";
import { SandboxPage } from "./pages/SandboxPage.js";

function WorkspaceRouter() {
  const { auth, loading, loadError, activeTab, setActiveTab, refreshAuthAndData } = useAppState();

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
      {(activeTab === "planner" || activeTab === "review" || activeTab === "stats") && (
        <section className="panel panel-body" style={{ maxWidth: 620, margin: "24px auto", textAlign: "center" }}>
          <h1 style={{ marginTop: 0, fontSize: 18 }}>Phase 5 Workspace</h1>
          <p style={{ color: "var(--ink-secondary)", fontSize: 13.5 }}>
            The Study Planner, 4-Mode FSRS Review Studio, and Stats &amp; Settings views are scheduled for Phase 5.
            Use the DAG Explorer and Algorithm Sandbox now to inspect characters and tune scoring.
          </p>
          <button type="button" className="btn btn-primary" onClick={() => setActiveTab("explorer")}>
            Return to DAG Explorer
          </button>
        </section>
      )}
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

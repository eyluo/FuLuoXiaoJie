import { Lock } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api, type AuthStatus } from "../api/client.js";

interface AuthGateProps {
  auth: AuthStatus;
  onAuthenticated: () => Promise<void>;
}

export function AuthGate({ auth, onAuthenticated }: AuthGateProps) {
  const isSetup = !auth.configured;
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (isSetup) {
      if (passphrase.length < 8) {
        setError("Passphrase must be at least 8 characters.");
        return;
      }
      if (passphrase !== confirm) {
        setError("Passphrases do not match.");
        return;
      }
    }
    setSubmitting(true);
    try {
      if (isSetup) {
        await api.setupPassphrase(passphrase);
      } else {
        await api.login(passphrase);
      }
      await onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-page">
      <section className="auth-card" aria-label={isSetup ? "Initial Setup" : "Sign In"}>
        <div className="auth-brand">
          <div className="seal-mark" aria-hidden="true">
            弗
          </div>
          <div>
            <h1>弗洛小姐 · FuLuoXiaoJie</h1>
            <div className="brand-sub">Simplified Mandarin DAG Studio</div>
          </div>
        </div>

        <p className="auth-desc">
          {isSetup
            ? "Create a single-user passphrase to protect your self-hosted learning progress and SRS data."
            : "Enter your passphrase to unlock your character DAG and spaced-repetition studio."}
        </p>

        <form className="auth-form" onSubmit={handleSubmit}>
          <div>
            <label className="field-label" htmlFor="auth-passphrase">
              {isSetup ? "New Passphrase (min. 8 characters)" : "Passphrase"}
            </label>
            <input
              id="auth-passphrase"
              className="input"
              type="password"
              autoFocus
              autoComplete={isSetup ? "new-password" : "current-password"}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="Enter passphrase"
              required
            />
          </div>

          {isSetup && (
            <div>
              <label className="field-label" htmlFor="auth-passphrase-confirm">
                Confirm Passphrase
              </label>
              <input
                id="auth-passphrase-confirm"
                className="input"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Re-enter passphrase"
                required
              />
            </div>
          )}

          {error && (
            <div className="alert-error" role="alert">
              {error}
            </div>
          )}

          <button
            id="auth-submit-btn"
            className="btn btn-primary"
            type="submit"
            disabled={submitting}
            style={{ width: "100%", padding: "10px 14px" }}
          >
            <Lock size={15} />
            {submitting
              ? "Verifying..."
              : isSetup
                ? "Set Passphrase & Enter"
                : "Unlock Studio"}
          </button>
        </form>
      </section>
    </main>
  );
}

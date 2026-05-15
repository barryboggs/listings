"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "../layout";

/**
 * /dashboard/account — self-service password change.
 *
 * Two modes:
 *  - Forced (`user.passwordTemp` is true): banner appears, current-password
 *    field is hidden. Triggered automatically by the dashboard layout
 *    redirecting any user with passwordTemp=true to this page.
 *  - Voluntary: current password required. User navigates here on their own
 *    via the header "Account" link.
 */
export default function AccountPage() {
  const router = useRouter();
  const user = useUser();
  const isForced = !!user?.passwordTemp;

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [savedAt, setSavedAt] = useState(null);

  const newPasswordTooShort = newPassword.length > 0 && newPassword.length < 6;
  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const canSubmit =
    !saving &&
    newPassword.length >= 6 &&
    newPassword === confirmPassword &&
    (isForced || currentPassword.length > 0);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/account/password", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: isForced ? undefined : currentPassword,
          newPassword,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error || `Update failed (HTTP ${res.status})`);
        setSaving(false);
        return;
      }
      setSavedAt(new Date().toLocaleTimeString());
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      // After a forced change we need a hard reload — soft navigation
      // doesn't re-mount the dashboard layout, so its stale local user
      // state would still have passwordTemp=true and keep redirecting
      // us back to this page. Voluntary changes don't need that;
      // passwordTemp stays false so router.refresh is enough.
      setTimeout(() => {
        if (isForced) {
          window.location.href = "/dashboard";
        } else {
          router.refresh();
        }
      }, 800);
    } catch (e) {
      setError(e.message || "Network error");
    }
    setSaving(false);
  };

  if (!user) return null;

  return (
    <div className="max-w-md">
      <div className="mb-5">
        <h2 className="text-lg font-bold text-white">Account</h2>
        <p className="text-xs mt-0.5" style={{ color: "#666" }}>
          Signed in as {user.email} · {user.role}
        </p>
      </div>

      {isForced && (
        <div className="mb-4 px-4 py-3 rounded-lg" style={{ background: "#2d1b00", border: "1px solid #5c3a00" }}>
          <div className="text-xs font-semibold mb-1" style={{ color: "#fbbf24" }}>
            Set your password
          </div>
          <p className="text-[11px]" style={{ color: "#fbbf24cc" }}>
            You're using a temporary password set by an admin. Choose a new one to continue.
          </p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="rounded-xl p-5 space-y-4" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
        {!isForced && (
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#777" }}>
              Current Password
            </label>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full px-3 py-2.5 rounded-md text-sm"
              style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }}
            />
          </div>
        )}

        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#777" }}>
            New Password
          </label>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            className="w-full px-3 py-2.5 rounded-md text-sm"
            style={{ background: "#1c1c1f", border: `1px solid ${newPasswordTooShort ? "#5c1a1a" : "#2a2a2e"}`, color: "#ddd" }}
          />
          <p className="text-[11px] mt-1" style={{ color: newPasswordTooShort ? "#f87171" : "#555" }}>
            At least 6 characters.
          </p>
        </div>

        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#777" }}>
            Confirm New Password
          </label>
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
            className="w-full px-3 py-2.5 rounded-md text-sm"
            style={{ background: "#1c1c1f", border: `1px solid ${mismatch ? "#5c1a1a" : "#2a2a2e"}`, color: "#ddd" }}
          />
          {mismatch && (
            <p className="text-[11px] mt-1" style={{ color: "#f87171" }}>Passwords don't match.</p>
          )}
        </div>

        {error && (
          <div className="px-3 py-2 rounded text-[11px]" style={{ background: "#2d0a0a", border: "1px solid #5c1a1a", color: "#f87171" }}>
            {error}
          </div>
        )}
        {savedAt && (
          <div className="px-3 py-2 rounded text-[11px]" style={{ background: "#0d2818", border: "1px solid #2d5a2d", color: "#6ee7b7" }}>
            Password updated at {savedAt}. {isForced ? "Redirecting…" : ""}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          {!isForced && (
            <button
              type="button"
              onClick={() => router.back()}
              className="px-4 py-2 rounded-md text-xs font-semibold"
              style={{ background: "#222", border: "1px solid #333", color: "#aaa" }}
            >
              Cancel
            </button>
          )}
          <button
            type="submit"
            disabled={!canSubmit}
            className="px-5 py-2 rounded-md text-xs font-semibold text-white transition-opacity"
            style={{ background: "#a78bfa", opacity: canSubmit ? 1 : 0.5 }}
          >
            {saving ? "Saving…" : isForced ? "Set Password" : "Change Password"}
          </button>
        </div>
      </form>
    </div>
  );
}

"use client";

import { useState, useEffect } from "react";
import { useUser } from "../layout";
import { ROLES, getBrandConfig } from "@/lib/data";

// Readable temp-password generator — excludes ambiguous chars (0/O, 1/l/I)
// so passwords are easy to read aloud or copy without confusion.
function generatePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let pw = "";
  for (let i = 0; i < 10; i++) {
    pw += chars[Math.floor(Math.random() * chars.length)];
  }
  return pw;
}

function UserRow({ user, onEdit, onDelete }) {
  const roleColors = {
    admin: { bg: "#a78bfa20", color: "#a78bfa" },
    manager: { bg: "#93c5fd20", color: "#93c5fd" },
    editor: { bg: "#fbbf2420", color: "#fbbf24" },
    viewer: { bg: "#88888820", color: "#888888" },
  };
  const rc = roleColors[user.role] || roleColors.viewer;
  const isAllBrands = user.brands.includes("*");

  return (
    <div className="flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-[#1a1a1d]" style={{ borderBottom: "1px solid #1a1a1d" }}>
      <div className="w-9 h-9 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0" style={{ background: "#222", border: "1px solid #333", color: "#aaa" }}>
        {user.initials}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-white">{user.name}</div>
        <div className="text-xs font-mono" style={{ color: "#666" }}>{user.email}</div>
      </div>
      <span className="hidden sm:inline-flex px-2.5 py-0.5 rounded text-[11px] font-semibold capitalize" style={{ background: rc.bg, color: rc.color }}>
        {user.role}
      </span>
      <div className="hidden md:flex items-center gap-1">
        {isAllBrands ? (
          <span className="text-[10px] font-semibold px-2 py-0.5 rounded" style={{ background: "#34d39920", color: "#34d399" }}>All Brands</span>
        ) : (
          user.brands.map((b) => {
            const config = getBrandConfig(b);
            return <span key={b} className="w-2.5 h-2.5 rounded-sm" style={{ background: config.color }} title={config.name} />;
          })
        )}
      </div>
      <div className="text-[11px] hidden lg:block" style={{ color: "#555" }}>Added {user.createdAt}</div>
      <div className="flex gap-1.5">
        <button onClick={() => onEdit(user)} className="px-2.5 py-1 rounded text-[11px] font-semibold" style={{ background: "#222", border: "1px solid #2a2a2e", color: "#888" }}>Edit</button>
        {user.role !== "admin" && (
          <button onClick={() => onDelete(user)} className="px-2.5 py-1 rounded text-[11px] font-semibold" style={{ background: "#2d0a0a", border: "1px solid #5c1a1a", color: "#f87171" }}>Remove</button>
        )}
      </div>
    </div>
  );
}

function UserModal({ user, brands, onClose, onSave, saving }) {
  const isNew = !user;
  const [form, setForm] = useState(user || { name: "", email: "", password: "", role: "editor", initials: "", brands: [] });
  // Edit mode: password reset is opt-in — the field only appears once the
  // admin clicks "Reset Password", and form.password stays undefined until
  // then so updateUser leaves the existing password untouched.
  const [showPasswordReset, setShowPasswordReset] = useState(false);
  const isAllBrands = form.brands.includes("*");

  const toggleAllBrands = () => setForm({ ...form, brands: isAllBrands ? [] : ["*"] });

  const toggleBrand = (brandId) => {
    let cur = isAllBrands ? [] : [...form.brands];
    cur = cur.includes(brandId) ? cur.filter((b) => b !== brandId) : [...cur, brandId];
    setForm({ ...form, brands: cur });
  };

  const handleNameChange = (name) => {
    const parts = name.trim().split(" ");
    const initials = parts.length >= 2 ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase() : name.slice(0, 2).toUpperCase();
    setForm({ ...form, name, initials });
  };

  const hasValidBrands = isAllBrands || form.brands.length > 0;
  // New users must have a password. Edit mode: a password is only required
  // if the admin opened the reset field (showPasswordReset) — otherwise it
  // stays undefined and the existing password is left untouched.
  const needsPassword = isNew || showPasswordReset;
  const saveDisabled =
    saving ||
    !form.name ||
    !form.email ||
    !hasValidBrands ||
    (needsPassword && !form.password);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}>
      <div className="animate-fade-scale w-full max-w-md max-h-[85vh] flex flex-col rounded-xl overflow-hidden" style={{ background: "#151517", border: "1px solid #2a2a2e" }}>
        <div className="px-6 py-5 flex justify-between items-start" style={{ borderBottom: "1px solid #2a2a2e" }}>
          <div>
            <span className="text-[11px] font-semibold uppercase tracking-wider block mb-1" style={{ color: "#888" }}>{isNew ? "Add User" : "Edit User"}</span>
            <h3 className="text-base font-semibold text-white">{isNew ? "New Team Member" : form.name}</h3>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-md flex items-center justify-center text-sm" style={{ background: "#222", border: "1px solid #333", color: "#888" }}>×</button>
        </div>

        <div className="px-6 py-5 space-y-4 overflow-y-auto flex-1">
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#777" }}>Full Name</label>
            <input value={form.name} onChange={(e) => handleNameChange(e.target.value)} placeholder="Jane Smith" className="w-full px-3 py-2.5 rounded-md text-sm" style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }} />
          </div>
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#777" }}>Email</label>
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="jane@drivenbrands.com" className="w-full px-3 py-2.5 rounded-md text-sm" style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }} />
          </div>
          {isNew && (
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#777" }}>
                Temporary Password <span style={{ color: "#f87171" }}>*</span>
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={form.password || ""}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  placeholder="Set or generate an initial password"
                  className="flex-1 px-3 py-2.5 rounded-md text-sm font-mono"
                  style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }}
                />
                <button
                  type="button"
                  onClick={() => setForm({ ...form, password: generatePassword() })}
                  className="px-3 py-2.5 rounded-md text-xs font-semibold whitespace-nowrap"
                  style={{ background: "#222", border: "1px solid #2a2a2e", color: "#a78bfa" }}
                >
                  Generate
                </button>
              </div>
              <p className="text-[11px] mt-1" style={{ color: "#555" }}>
                Required. You'll see this password after the user is created — share it with them then.
              </p>
            </div>
          )}

          {!isNew && (
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#777" }}>Password</label>
              {!showPasswordReset ? (
                <button
                  type="button"
                  onClick={() => { setShowPasswordReset(true); setForm({ ...form, password: "" }); }}
                  className="px-3 py-2 rounded-md text-xs font-semibold"
                  style={{ background: "#222", border: "1px solid #2a2a2e", color: "#aaa" }}
                >
                  Reset Password
                </button>
              ) : (
                <>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={form.password || ""}
                      onChange={(e) => setForm({ ...form, password: e.target.value })}
                      placeholder="New password"
                      className="flex-1 px-3 py-2.5 rounded-md text-sm font-mono"
                      style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }}
                    />
                    <button
                      type="button"
                      onClick={() => setForm({ ...form, password: generatePassword() })}
                      className="px-3 py-2.5 rounded-md text-xs font-semibold whitespace-nowrap"
                      style={{ background: "#222", border: "1px solid #2a2a2e", color: "#a78bfa" }}
                    >
                      Generate
                    </button>
                    <button
                      type="button"
                      onClick={() => { setShowPasswordReset(false); setForm({ ...form, password: undefined }); }}
                      className="px-3 py-2.5 rounded-md text-xs font-semibold"
                      style={{ background: "#222", border: "1px solid #2a2a2e", color: "#888" }}
                    >
                      Cancel
                    </button>
                  </div>
                  <p className="text-[11px] mt-1" style={{ color: "#555" }}>
                    Leave the reset cancelled to keep the current password. You'll see the new one after saving.
                  </p>
                </>
              )}
            </div>
          )}
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider mb-2" style={{ color: "#777" }}>Role</label>
            <div className="space-y-1.5">
              {ROLES.map((role) => (
                <label key={role.id} className="flex gap-3 px-3 py-2.5 rounded-md cursor-pointer transition-colors" style={{ background: form.role === role.id ? "#1c1c1f" : "transparent", border: `1px solid ${form.role === role.id ? "#2a2a2e" : "transparent"}` }}>
                  <input type="radio" name="role" checked={form.role === role.id} onChange={() => setForm({ ...form, role: role.id })} style={{ accentColor: "#a78bfa", marginTop: "1px" }} />
                  <div>
                    <div className="text-xs font-semibold text-white">{role.label}</div>
                    <div className="text-[11px]" style={{ color: "#666" }}>{role.description}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider mb-2" style={{ color: "#777" }}>Brand Access</label>
            <button type="button" onClick={toggleAllBrands} className="flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold transition-colors mb-2 w-full" style={{ background: isAllBrands ? "#34d39918" : "#1c1c1f", border: `1.5px solid ${isAllBrands ? "#34d399" : "#2a2a2e"}`, color: isAllBrands ? "#34d399" : "#888" }}>
              <span className="text-sm">{isAllBrands ? "✓" : "○"}</span> All Brands (full access)
            </button>
            <div className="flex gap-2 flex-wrap">
              {brands.map((b) => {
                const active = !isAllBrands && form.brands.includes(b.id);
                return (
                  <button key={b.id} type="button" onClick={() => toggleBrand(b.id)} disabled={isAllBrands} className="flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold transition-colors" style={{ background: active ? b.color + "18" : "#1c1c1f", border: `1.5px solid ${active ? b.color : "#2a2a2e"}`, color: active ? b.color : isAllBrands ? "#444" : "#888", opacity: isAllBrands ? 0.5 : 1 }}>
                    <span className="w-2 h-2 rounded-sm" style={{ background: b.color }} />{b.name}
                  </button>
                );
              })}
            </div>
            {!hasValidBrands && <p className="text-[11px] mt-1.5" style={{ color: "#f87171" }}>Select at least one brand or enable "All Brands"</p>}
          </div>
        </div>

        <div className="px-6 py-4 flex justify-end gap-2" style={{ borderTop: "1px solid #2a2a2e" }}>
          <button onClick={onClose} className="px-4 py-2 rounded-md text-xs font-semibold" style={{ background: "#222", border: "1px solid #333", color: "#aaa" }}>Cancel</button>
          <button
            onClick={() => onSave(form)}
            disabled={saveDisabled}
            className="px-5 py-2 rounded-md text-xs font-semibold text-white transition-opacity"
            style={{ background: "#a78bfa", opacity: saveDisabled ? 0.5 : 1 }}
          >
            {saving ? "Saving..." : isNew ? "Add User" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteModal({ user, onClose, onConfirm, deleting }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}>
      <div className="animate-fade-scale w-full max-w-sm rounded-xl overflow-hidden" style={{ background: "#151517", border: "1px solid #2a2a2e" }}>
        <div className="px-6 py-5">
          <h3 className="text-base font-semibold text-white mb-2">Remove User</h3>
          <p className="text-sm" style={{ color: "#999" }}>Are you sure you want to remove <strong className="text-white">{user.name}</strong> ({user.email})? They will immediately lose access.</p>
        </div>
        <div className="px-6 py-4 flex justify-end gap-2" style={{ borderTop: "1px solid #2a2a2e" }}>
          <button onClick={onClose} className="px-4 py-2 rounded-md text-xs font-semibold" style={{ background: "#222", border: "1px solid #333", color: "#aaa" }}>Cancel</button>
          <button onClick={() => onConfirm(user)} disabled={deleting} className="px-5 py-2 rounded-md text-xs font-semibold text-white" style={{ background: "#dc2626", opacity: deleting ? 0.6 : 1 }}>
            {deleting ? "Removing..." : "Remove User"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Shown once after a user is created or has their password reset. The
// password is only available right here — it's never returned by the
// users list endpoint — so the admin has to copy it now.
function CredentialModal({ credential, onClose }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(credential.password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API can fail on insecure contexts — the password is
      // still visible on screen for manual copy
    }
  };
  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}>
      <div className="animate-fade-scale w-full max-w-sm rounded-xl overflow-hidden" style={{ background: "#151517", border: "1px solid #2a2a2e" }}>
        <div className="px-6 py-5">
          <span className="text-[11px] font-semibold uppercase tracking-wider block mb-1" style={{ color: "#34d399" }}>
            {credential.reset ? "Password Reset" : "User Created"}
          </span>
          <h3 className="text-base font-semibold text-white mb-1">{credential.name}</h3>
          <p className="text-xs mb-4" style={{ color: "#888" }}>{credential.email}</p>

          <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#777" }}>
            {credential.reset ? "New Password" : "Temporary Password"}
          </label>
          <div className="flex gap-2">
            <div className="flex-1 px-3 py-2.5 rounded-md text-sm font-mono" style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#e8e8e8" }}>
              {credential.password}
            </div>
            <button
              onClick={copy}
              className="px-3 py-2.5 rounded-md text-xs font-semibold whitespace-nowrap"
              style={{ background: copied ? "#1a2e1a" : "#222", border: `1px solid ${copied ? "#2d5a2d" : "#2a2a2e"}`, color: copied ? "#6ee7b7" : "#a78bfa" }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="text-[11px] mt-3 px-3 py-2 rounded" style={{ background: "#2d1b00", border: "1px solid #5c3a00", color: "#fbbf24" }}>
            Share this with {credential.name.split(" ")[0]} now — it won't be shown again.
          </p>
        </div>
        <div className="px-6 py-4 flex justify-end" style={{ borderTop: "1px solid #2a2a2e" }}>
          <button onClick={onClose} className="px-5 py-2 rounded-md text-xs font-semibold text-white" style={{ background: "#a78bfa" }}>Done</button>
        </div>
      </div>
    </div>
  );
}

export default function AdminPage() {
  const currentUser = useUser();
  const [users, setUsers] = useState([]);
  const [editingUser, setEditingUser] = useState(undefined);
  const [deletingUser, setDeletingUser] = useState(null);
  const [toast, setToast] = useState(null);
  const [brands, setBrands] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [createdCredential, setCreatedCredential] = useState(null);

  // Token-broker state — admin UI for the integration secret used by
  // external apps (e.g. Ben's local scripts) to fetch the Semrush
  // access token via /api/integrations/semrush-access-token.
  const [brokerMeta, setBrokerMeta] = useState(null); // { configured, hint, createdAt, createdBy, lastUsedAt }
  const [newBrokerSecret, setNewBrokerSecret] = useState(null); // one-time plaintext display
  const [rotatingBroker, setRotatingBroker] = useState(false);

  // Fetch users, brands, and broker meta on mount
  useEffect(() => {
    Promise.all([
      fetch("/api/users").then((r) => r.json()),
      fetch("/api/semrush/locations").then((r) => r.json()),
      fetch("/api/admin/integration-broker-secret").then((r) => r.json()).catch(() => null),
    ])
      .then(([userData, locData, brokerData]) => {
        setUsers(userData.users || []);
        setBrands(locData.brands || []);
        if (brokerData) setBrokerMeta(brokerData);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  if (currentUser?.role !== "admin") {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="text-3xl mb-3">🔒</div>
          <h2 className="text-base font-bold text-white mb-1">Access Restricted</h2>
          <p className="text-sm" style={{ color: "#666" }}>Only admin users can manage team members.</p>
        </div>
      </div>
    );
  }

  const logActivity = async (action, details) => {
    try {
      await fetch("/api/activity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, location: "", brand: "system", details }),
      });
    } catch {}
  };

  const handleSave = async (userData) => {
    setSaving(true);
    try {
      if (editingUser === null) {
        const res = await fetch("/api/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(userData),
        });
        const data = await res.json();
        if (res.ok) {
          setUsers([...users, data.user]);
          // Surface the password the admin just set so it can be copied
          // and handed off — it's never retrievable again after this.
          setCreatedCredential({ name: data.user.name, email: data.user.email, password: userData.password });
          logActivity("Added user", `${data.user.name} (${data.user.email}) — role: ${data.user.role}`);
        } else {
          showToast(`Error: ${data.error}`);
        }
      } else {
        const res = await fetch("/api/users", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...userData, id: editingUser.id }),
        });
        const data = await res.json();
        if (res.ok) {
          setUsers(users.map((u) => (u.id === editingUser.id ? data.user : u)));
          // If the admin reset the password, show the new one once.
          if (userData.password) {
            setCreatedCredential({ name: data.user.name, email: data.user.email, password: userData.password, reset: true });
            logActivity("Reset user password", `${data.user.name} (${data.user.email})`);
          } else {
            showToast(`${data.user.name} updated`);
            logActivity("Updated user", `${data.user.name} (${data.user.email}) — role: ${data.user.role}`);
          }
        } else {
          showToast(`Error: ${data.error}`);
        }
      }
    } catch {
      showToast("Network error — please try again");
    }
    setSaving(false);
    setEditingUser(undefined);
  };

  const handleRotateBrokerSecret = async () => {
    const isRotation = brokerMeta?.configured;
    const confirmMsg = isRotation
      ? "Generate a new broker secret? This will immediately invalidate the current one. Anyone using the old secret (Ben's script, etc.) will get 401s until you share the new value."
      : "Generate the first broker secret? It will be shown ONCE — save it before closing the dialog.";
    if (!confirm(confirmMsg)) return;

    setRotatingBroker(true);
    try {
      const res = await fetch("/api/admin/integration-broker-secret", { method: "POST" });
      const data = await res.json();
      if (res.ok && data.success) {
        setNewBrokerSecret(data.plaintext);
        setBrokerMeta(data.meta);
        showToast(isRotation ? "Secret rotated — copy the new value" : "Secret generated — copy it now");
        logActivity(isRotation ? "Rotated integration broker secret" : "Generated integration broker secret", "Provider: semrush");
      } else {
        showToast(`${isRotation ? "Rotation" : "Generation"} failed: ${data.error || res.status}`);
      }
    } catch (e) {
      showToast(`Failed: ${e.message}`);
    }
    setRotatingBroker(false);
  };

  const handleRevokeBrokerSecret = async () => {
    if (!confirm("Revoke the broker secret? External integrations using it will get 401s until you generate a new one.")) return;
    try {
      const res = await fetch("/api/admin/integration-broker-secret", { method: "DELETE" });
      if (res.ok) {
        setBrokerMeta({ provider: "semrush", configured: false });
        showToast("Broker secret revoked");
        logActivity("Revoked integration broker secret", "Provider: semrush");
      } else {
        const data = await res.json().catch(() => ({}));
        showToast(`Revoke failed: ${data.error || res.status}`);
      }
    } catch (e) {
      showToast(`Revoke failed: ${e.message}`);
    }
  };

  const handleSyncRichMappings = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/db/sync-rich-mappings", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setSyncResult(data);
        showToast(`Mapping synced: ${data.matched}/${data.oldCount} locations matched`);
        logActivity("Synced rich-field mappings", `${data.matched} matched, ${data.updated} shop rows updated`);
      } else {
        showToast(`Sync failed: ${data.error || res.status}`);
      }
    } catch (e) {
      showToast(`Sync failed: ${e.message}`);
    }
    setSyncing(false);
  };

  const handleDelete = async (user) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/users?id=${user.id}`, { method: "DELETE" });
      if (res.ok) {
        setUsers(users.filter((u) => u.id !== user.id));
        showToast(`${user.name} removed from the team`);
        logActivity("Removed user", `${user.name} (${user.email})`);
      } else {
        const data = await res.json();
        showToast(`Error: ${data.error}`);
      }
    } catch {
      showToast("Network error");
    }
    setSaving(false);
    setDeletingUser(null);
  };

  if (loading) {
    return <div className="flex items-center justify-center py-20"><span className="text-sm" style={{ color: "#666" }}>Loading users...</span></div>;
  }

  return (
    <>
      {toast && (
        <div className="fixed bottom-6 right-6 z-[60] animate-slide-up px-5 py-3 rounded-lg text-sm font-medium flex items-center gap-2" style={{ background: "#1a2e1a", border: "1px solid #2d5a2d", color: "#6ee7b7" }}>
          <span>✓</span> {toast}
        </div>
      )}

      <div className="flex flex-wrap justify-between items-center gap-3 mb-5">
        <div>
          <h2 className="text-lg font-bold text-white">User Management</h2>
          <p className="text-xs mt-0.5" style={{ color: "#666" }}>Add team members without additional Semrush seats — {brands.length} brands available</p>
        </div>
        <button onClick={() => setEditingUser(null)} className="px-4 py-2 rounded-md text-xs font-semibold text-white" style={{ background: "#a78bfa" }}>+ Add User</button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        {[
          { label: "Total Users", value: users.length, color: "#e8e8e8" },
          { label: "Admins", value: users.filter((u) => u.role === "admin").length, color: "#a78bfa" },
          { label: "Managers", value: users.filter((u) => u.role === "manager").length, color: "#93c5fd" },
          { label: "Editors / Viewers", value: users.filter((u) => u.role === "editor" || u.role === "viewer").length, color: "#fbbf24" },
        ].map((stat) => (
          <div key={stat.label} className="px-4 py-3 rounded-lg" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
            <div className="text-[11px] font-semibold" style={{ color: "#888" }}>{stat.label}</div>
            <div className="text-2xl font-bold mt-0.5" style={{ color: stat.color }}>{stat.value}</div>
          </div>
        ))}
      </div>

      <div className="rounded-xl overflow-hidden" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
        {users.map((user) => (
          <UserRow key={user.id} user={user} onEdit={setEditingUser} onDelete={setDeletingUser} />
        ))}
      </div>

      <div className="mt-5 p-4 rounded-lg" style={{ background: "#1a1a1d", border: "1px solid #222" }}>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div>
            <h4 className="text-xs font-bold" style={{ color: "#aaa" }}>Semrush Integration</h4>
            <p className="text-[11px] mt-0.5" style={{ color: "#666" }}>
              Map old-API location IDs to new-API IDs so rich fields (description, categories, coordinates, social) can load.
            </p>
          </div>
          <button
            onClick={handleSyncRichMappings}
            disabled={syncing}
            className="px-4 py-2 rounded-md text-xs font-semibold text-white transition-opacity"
            style={{ background: "#0ea5e9", opacity: syncing ? 0.5 : 1 }}
          >
            {syncing ? "Syncing…" : "Sync rich-field mappings"}
          </button>
        </div>
        {syncResult && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] mb-3">
            <div className="px-3 py-2 rounded" style={{ background: "#0f1419", border: "1px solid #1e2a30" }}>
              <div style={{ color: "#888" }}>Old API locations</div>
              <div className="text-base font-bold text-white">{syncResult.oldCount}</div>
            </div>
            <div className="px-3 py-2 rounded" style={{ background: "#0f1419", border: "1px solid #1e2a30" }}>
              <div style={{ color: "#888" }}>New API locations</div>
              <div className="text-base font-bold text-white">{syncResult.newCount}</div>
            </div>
            <div className="px-3 py-2 rounded" style={{ background: "#0f1419", border: "1px solid #1e2a30" }}>
              <div style={{ color: "#888" }}>Matched</div>
              <div className="text-base font-bold" style={{ color: "#34d399" }}>{syncResult.matched}</div>
            </div>
            <div className="px-3 py-2 rounded" style={{ background: "#0f1419", border: "1px solid #1e2a30" }}>
              <div style={{ color: "#888" }}>Shop rows updated</div>
              <div className="text-base font-bold text-white">{syncResult.updated}</div>
            </div>
            <div className="col-span-2 sm:col-span-4 text-[11px] mt-1" style={{ color: "#666" }}>
              By strategy — url: {syncResult.strategies.url} · phone: {syncResult.strategies.phone} · address: {syncResult.strategies.address}
              {syncResult.missing > 0 && ` · matched-but-no-shop-row: ${syncResult.missing}`}
              {syncResult.ambiguous > 0 && ` · ambiguous: ${syncResult.ambiguous}`}
            </div>
            {syncResult.dbErrors && syncResult.dbErrors.length > 0 && (
              <div className="col-span-2 sm:col-span-4 px-3 py-2 rounded text-[11px]" style={{ background: "#2d0a0a", border: "1px solid #5c1a1a", color: "#f87171" }}>
                <div className="font-semibold mb-1">Database errors (first {syncResult.dbErrors.length}):</div>
                {syncResult.dbErrors.map((e, i) => (
                  <div key={i} className="font-mono text-[10px] leading-snug">{e}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Integration Token Broker — for external apps (e.g. Ben's local
          scripts) that need the current Semrush access token without
          holding the refresh-token chain themselves. */}
      <div className="mt-5 p-4 rounded-lg" style={{ background: "#1a1a1d", border: "1px solid #222" }}>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div>
            <h4 className="text-xs font-bold" style={{ color: "#aaa" }}>Integration Token Broker</h4>
            <p className="text-[11px] mt-0.5" style={{ color: "#666" }}>
              External apps can fetch the current Semrush access token via{" "}
              <span className="font-mono">GET /api/integrations/semrush-access-token</span>{" "}
              using a bearer secret. They never see the refresh token, so they can&apos;t break the rotation chain.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleRotateBrokerSecret}
              disabled={rotatingBroker}
              className="px-4 py-2 rounded-md text-xs font-semibold text-white transition-opacity"
              style={{ background: "#0ea5e9", opacity: rotatingBroker ? 0.5 : 1 }}
            >
              {rotatingBroker
                ? (brokerMeta?.configured ? "Rotating…" : "Generating…")
                : (brokerMeta?.configured ? "Rotate Secret" : "Generate Secret")}
            </button>
            {brokerMeta?.configured && (
              <button
                onClick={handleRevokeBrokerSecret}
                className="px-3 py-2 rounded-md text-xs font-semibold"
                style={{ background: "#2d0a0a", border: "1px solid #5c1a1a", color: "#f87171" }}
              >
                Revoke
              </button>
            )}
          </div>
        </div>
        {brokerMeta?.configured ? (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
            <div className="px-3 py-2 rounded" style={{ background: "#0f1419", border: "1px solid #1e2a30" }}>
              <div style={{ color: "#888" }}>Hint (last 4 chars)</div>
              <div className="font-mono text-base font-bold text-white">…{brokerMeta.hint}</div>
            </div>
            <div className="px-3 py-2 rounded" style={{ background: "#0f1419", border: "1px solid #1e2a30" }}>
              <div style={{ color: "#888" }}>Generated</div>
              <div className="text-white">{brokerMeta.createdAt ? new Date(brokerMeta.createdAt).toLocaleString() : "—"}</div>
              {brokerMeta.createdBy && <div style={{ color: "#666" }}>by {brokerMeta.createdBy}</div>}
            </div>
            <div className="px-3 py-2 rounded" style={{ background: "#0f1419", border: "1px solid #1e2a30" }}>
              <div style={{ color: "#888" }}>Last used by external app</div>
              <div className="text-white">{brokerMeta.lastUsedAt ? new Date(brokerMeta.lastUsedAt).toLocaleString() : "Never"}</div>
            </div>
          </div>
        ) : (
          <p className="text-[11px]" style={{ color: "#666" }}>
            No broker secret configured. Click <strong>Generate Secret</strong> to issue one. Anyone using{" "}
            <span className="font-mono">/api/integrations/semrush-access-token</span> currently gets 401.
          </p>
        )}
      </div>

      <div className="mt-5 p-4 rounded-lg" style={{ background: "#1a1a1d", border: "1px solid #222" }}>
        <h4 className="text-xs font-bold mb-3" style={{ color: "#aaa" }}>Role Permissions</h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {ROLES.map((role) => (
            <div key={role.id} className="flex items-start gap-2 text-xs" style={{ color: "#777" }}>
              <span className="font-semibold capitalize" style={{ color: "#aaa", width: "70px", flexShrink: 0 }}>{role.label}</span>
              <span>{role.description}</span>
            </div>
          ))}
        </div>
        <p className="text-[11px] mt-3" style={{ color: "#555" }}>
          Users persist within the current server session. For production, connect to a database for permanent storage.
        </p>
      </div>

      {editingUser !== undefined && <UserModal user={editingUser} brands={brands} onClose={() => setEditingUser(undefined)} onSave={handleSave} saving={saving} />}
      {deletingUser && <DeleteModal user={deletingUser} onClose={() => setDeletingUser(null)} onConfirm={handleDelete} deleting={saving} />}
      {createdCredential && <CredentialModal credential={createdCredential} onClose={() => setCreatedCredential(null)} />}
      {newBrokerSecret && <BrokerSecretModal secret={newBrokerSecret} onClose={() => setNewBrokerSecret(null)} />}
    </>
  );
}

/**
 * One-time-display modal for a newly-generated broker secret. The
 * plaintext is shown here ONCE and never recoverable from the DB
 * afterward (we only store the bcrypt hash). Admin must copy it
 * before closing.
 */
function BrokerSecretModal({ secret, onClose }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable in some contexts — manual copy from the input works.
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}>
      <div className="w-full max-w-[640px] rounded-xl overflow-hidden" style={{ background: "#151517", border: "1px solid #2a2a2e" }}>
        <div className="px-5 py-4" style={{ borderBottom: "1px solid #2a2a2e" }}>
          <h3 className="text-base font-semibold text-white">New broker secret generated</h3>
          <p className="text-xs mt-1" style={{ color: "#aaa" }}>
            Copy this value now — once you close this dialog it cannot be recovered. Share it with the integration owner via a secure channel (1Password, encrypted message — not Slack/email).
          </p>
        </div>
        <div className="px-5 py-4 space-y-3">
          <label className="block text-[11px] font-semibold uppercase tracking-wider" style={{ color: "#777" }}>
            Secret (48 chars)
          </label>
          <div className="flex gap-2">
            <input
              readOnly
              value={secret}
              onFocus={(e) => e.target.select()}
              className="flex-1 px-3 py-2 rounded-md text-xs font-mono"
              style={{ background: "#0c0c0e", border: "1px solid #2a2a2e", color: "#ddd" }}
            />
            <button
              onClick={copy}
              className="px-3 py-2 rounded-md text-xs font-semibold"
              style={{ background: copied ? "#0d2818" : "#1c1c1f", border: `1px solid ${copied ? "#2d5a2d" : "#2a2a2e"}`, color: copied ? "#34d399" : "#aaa" }}
            >
              {copied ? "Copied ✓" : "Copy"}
            </button>
          </div>
          <div className="p-3 rounded-md text-[11px]" style={{ background: "#2d1b0020", border: "1px solid #8b6b2040", color: "#fbbf24" }}>
            ⚠ Closing this dialog without copying means re-generating the secret. The previous secret is already invalid — any external app using the old one will return 401 until you share the new value.
          </div>
          <div className="text-[11px]" style={{ color: "#888" }}>
            <strong style={{ color: "#aaa" }}>How to use</strong>: external apps send this secret as <span className="font-mono">Authorization: Bearer &lt;secret&gt;</span> when calling <span className="font-mono">GET /api/integrations/semrush-access-token</span>. The response contains the current Semrush access token and its expiry.
          </div>
        </div>
        <div className="px-5 py-4 flex justify-end" style={{ borderTop: "1px solid #2a2a2e" }}>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-md text-xs font-semibold text-white"
            style={{ background: "#0ea5e9" }}
          >
            I&apos;ve copied it, close
          </button>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useState, useEffect } from "react";
import { useUser } from "../layout";
import { ROLES, getBrandConfig } from "@/lib/data";

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
              <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#777" }}>Temporary Password</label>
              <input type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Set initial password" className="w-full px-3 py-2.5 rounded-md text-sm" style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }} />
              <p className="text-[11px] mt-1" style={{ color: "#555" }}>User can change this after first login (in production)</p>
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
          <button onClick={() => onSave(form)} disabled={saving || !form.name || !form.email || !hasValidBrands} className="px-5 py-2 rounded-md text-xs font-semibold text-white transition-opacity" style={{ background: "#a78bfa", opacity: saving || !form.name || !form.email || !hasValidBrands ? 0.5 : 1 }}>
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

export default function AdminPage() {
  const currentUser = useUser();
  const [users, setUsers] = useState([]);
  const [editingUser, setEditingUser] = useState(undefined);
  const [deletingUser, setDeletingUser] = useState(null);
  const [toast, setToast] = useState(null);
  const [brands, setBrands] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Fetch users and brands on mount
  useEffect(() => {
    Promise.all([
      fetch("/api/users").then((r) => r.json()),
      fetch("/api/semrush/locations").then((r) => r.json()),
    ])
      .then(([userData, locData]) => {
        setUsers(userData.users || []);
        setBrands(locData.brands || []);
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
          showToast(`${data.user.name} added to the team`);
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
          showToast(`${data.user.name} updated`);
          logActivity("Updated user", `${data.user.name} (${data.user.email}) — role: ${data.user.role}`);
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
    </>
  );
}

"use client";

import { useState, useEffect, useCallback } from "react";
import { getBrandConfig } from "@/lib/data";
import { useUser } from "../layout";

function formatTime(isoString) {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now - date;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });

  if (diffDays === 0) return `Today ${time}`;
  if (diffDays === 1) return `Yesterday ${time}`;
  if (diffDays < 7) return `${diffDays}d ago ${time}`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + ` ${time}`;
}

export default function ActivityPage() {
  const currentUser = useUser();
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterBrand, setFilterBrand] = useState("all");
  const [filterUser, setFilterUser] = useState("all");
  const [clearing, setClearing] = useState(false);
  const [toast, setToast] = useState(null);

  const fetchActivity = useCallback(() => {
    fetch("/api/activity")
      .then((r) => r.json())
      .then((data) => setActivity(data.activity || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchActivity();
    // Auto-refresh every 30 seconds
    const interval = setInterval(fetchActivity, 30000);
    return () => clearInterval(interval);
  }, [fetchActivity]);

  const handleClear = async () => {
    if (!confirm("Clear all activity log entries? This cannot be undone.")) return;
    setClearing(true);
    try {
      const res = await fetch("/api/activity", { method: "DELETE" });
      if (res.ok) {
        fetchActivity();
        setToast("Activity log cleared");
        setTimeout(() => setToast(null), 3000);
      }
    } catch {}
    setClearing(false);
  };

  const users = [...new Set(activity.map((a) => a.user))];
  const brandIds = [...new Set(activity.map((a) => a.brand))];

  const filtered = activity.filter((entry) => {
    if (filterBrand !== "all" && entry.brand !== filterBrand) return false;
    if (filterUser !== "all" && entry.user !== filterUser) return false;
    return true;
  });

  const todayCount = activity.filter((a) => {
    const d = new Date(a.time);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  }).length;

  if (loading) {
    return <div className="flex items-center justify-center py-20"><span className="text-sm" style={{ color: "#666" }}>Loading activity...</span></div>;
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
          <h2 className="text-lg font-bold text-white">Activity Log</h2>
          <p className="text-xs mt-0.5" style={{ color: "#666" }}>
            Live audit trail — auto-refreshes every 30 seconds
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <select value={filterBrand} onChange={(e) => setFilterBrand(e.target.value)} className="px-3 py-1.5 rounded-md text-xs font-medium" style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#aaa" }}>
            <option value="all">All Brands</option>
            {brandIds.map((brandId) => {
              const b = getBrandConfig(brandId);
              return <option key={b.id} value={b.id}>{b.name}</option>;
            })}
          </select>
          <select value={filterUser} onChange={(e) => setFilterUser(e.target.value)} className="px-3 py-1.5 rounded-md text-xs font-medium" style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#aaa" }}>
            <option value="all">All Users</option>
            {users.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
          <button onClick={fetchActivity} className="px-3 py-1.5 rounded-md text-xs font-medium" style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#aaa" }}>
            Refresh
          </button>
          {currentUser?.role === "admin" && activity.length > 0 && (
            <button onClick={handleClear} disabled={clearing} className="px-3 py-1.5 rounded-md text-xs font-semibold" style={{ background: "#2d0a0a", border: "1px solid #5c1a1a", color: "#f87171", opacity: clearing ? 0.6 : 1 }}>
              {clearing ? "Clearing..." : "Clear Log"}
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        {[
          { label: "Today", value: todayCount, color: "#34d399" },
          { label: "Total Logged", value: activity.length, color: "#93c5fd" },
          { label: "Bulk Updates", value: activity.filter((a) => a.action.toLowerCase().includes("bulk")).length, color: "#fbbf24" },
          { label: "Active Users", value: users.length, color: "#a78bfa" },
        ].map((stat) => (
          <div key={stat.label} className="px-4 py-3 rounded-lg" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
            <div className="text-[11px] font-semibold" style={{ color: "#888" }}>{stat.label}</div>
            <div className="text-2xl font-bold mt-0.5" style={{ color: stat.color }}>{stat.value}</div>
          </div>
        ))}
      </div>

      <div className="rounded-xl overflow-hidden" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
        {filtered.map((entry, i) => {
          const brandColor = getBrandConfig(entry.brand).color;
          return (
            <div key={entry.id || i} className="flex items-start gap-4 px-5 py-3.5 transition-colors" style={{ background: i % 2 === 0 ? "#151517" : "#131315", borderBottom: i < filtered.length - 1 ? "1px solid #1a1a1d" : "none" }}>
              <span className="w-1 h-1 rounded-full mt-2 flex-shrink-0" style={{ background: brandColor }} />
              <div className="flex-shrink-0 w-32">
                <span className="text-[11px] font-mono" style={{ color: "#555" }}>{formatTime(entry.time)}</span>
              </div>
              <div className="flex-shrink-0 w-20">
                <span className="text-xs font-semibold" style={{ color: "#aaa" }}>{entry.user}</span>
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-xs font-semibold text-white">{entry.action}</span>
                {entry.location && (
                  <>
                    <span className="text-xs mx-2" style={{ color: "#444" }}>—</span>
                    <span className="text-xs" style={{ color: "#888" }}>{entry.location}</span>
                  </>
                )}
                {entry.details && <div className="text-[11px] mt-0.5" style={{ color: "#555" }}>{entry.details}</div>}
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div className="py-12 text-center text-sm" style={{ color: "#555" }}>
            {activity.length === 0 ? "No activity logged yet. Edit a location to create the first entry." : "No activity matches your filters"}
          </div>
        )}
      </div>

      <div className="mt-5 p-4 rounded-lg" style={{ background: "#1a1a1d", border: "1px solid #222" }}>
        <p className="text-xs leading-relaxed" style={{ color: "#777" }}>
          Activity is logged automatically when locations are edited, bulk updates are run, or users are managed. Entries persist in Vercel Postgres and are retained across deployments.
        </p>
      </div>
    </>
  );
}

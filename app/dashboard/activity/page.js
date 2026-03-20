"use client";

import { useState } from "react";
import { BRANDS, ACTIVITY_LOG } from "@/lib/data";

function getBrandColor(brandId) {
  return BRANDS.find((b) => b.id === brandId)?.color || "#666";
}

function formatTime(isoString) {
  const date = new Date(isoString);
  const now = new Date("2026-03-19T12:00:00");
  const diffMs = now - date;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });

  if (diffDays === 0) return `Today ${time}`;
  if (diffDays === 1) return `Yesterday ${time}`;
  return `${diffDays}d ago ${time}`;
}

export default function ActivityPage() {
  const [filterBrand, setFilterBrand] = useState("all");
  const [filterUser, setFilterUser] = useState("all");

  const users = [...new Set(ACTIVITY_LOG.map((a) => a.user))];

  const filtered = ACTIVITY_LOG.filter((entry) => {
    if (filterBrand !== "all" && entry.brand !== filterBrand) return false;
    if (filterUser !== "all" && entry.user !== filterUser) return false;
    return true;
  });

  return (
    <>
      <div className="flex flex-wrap justify-between items-center gap-3 mb-5">
        <div>
          <h2 className="text-lg font-bold text-white">Activity Log</h2>
          <p className="text-xs mt-0.5" style={{ color: "#666" }}>
            All API interactions are logged with user attribution
          </p>
        </div>
        <div className="flex gap-2">
          <select
            value={filterBrand}
            onChange={(e) => setFilterBrand(e.target.value)}
            className="px-3 py-1.5 rounded-md text-xs font-medium"
            style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#aaa" }}
          >
            <option value="all">All Brands</option>
            {BRANDS.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <select
            value={filterUser}
            onChange={(e) => setFilterUser(e.target.value)}
            className="px-3 py-1.5 rounded-md text-xs font-medium"
            style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#aaa" }}
          >
            <option value="all">All Users</option>
            {users.map((u) => (
              <option key={u} value={u}>{u}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        {[
          { label: "Today", value: ACTIVITY_LOG.filter((a) => a.time.startsWith("2026-03-19")).length, color: "#34d399" },
          { label: "This Week", value: ACTIVITY_LOG.length, color: "#93c5fd" },
          { label: "Bulk Updates", value: ACTIVITY_LOG.filter((a) => a.action.startsWith("Bulk")).length, color: "#fbbf24" },
          { label: "Active Users", value: users.length, color: "#a78bfa" },
        ].map((stat) => (
          <div key={stat.label} className="px-4 py-3 rounded-lg" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
            <div className="text-[11px] font-semibold" style={{ color: "#888" }}>{stat.label}</div>
            <div className="text-2xl font-bold mt-0.5" style={{ color: stat.color }}>{stat.value}</div>
          </div>
        ))}
      </div>

      {/* Log entries */}
      <div className="rounded-xl overflow-hidden" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
        {filtered.map((entry, i) => (
          <div
            key={entry.id}
            className="flex items-start gap-4 px-5 py-3.5 transition-colors"
            style={{
              background: i % 2 === 0 ? "#151517" : "#131315",
              borderBottom: i < filtered.length - 1 ? "1px solid #1a1a1d" : "none",
            }}
          >
            <span className="w-1 h-1 rounded-full mt-2 flex-shrink-0" style={{ background: getBrandColor(entry.brand) }} />

            <div className="flex-shrink-0 w-28">
              <span className="text-[11px] font-mono" style={{ color: "#555" }}>
                {formatTime(entry.time)}
              </span>
            </div>

            <div className="flex-shrink-0 w-20">
              <span className="text-xs font-semibold" style={{ color: "#aaa" }}>{entry.user}</span>
            </div>

            <div className="flex-1 min-w-0">
              <span className="text-xs font-semibold text-white">{entry.action}</span>
              <span className="text-xs mx-2" style={{ color: "#444" }}>—</span>
              <span className="text-xs" style={{ color: "#888" }}>{entry.location}</span>
              {entry.details && (
                <div className="text-[11px] mt-0.5" style={{ color: "#555" }}>{entry.details}</div>
              )}
            </div>
          </div>
        ))}

        {filtered.length === 0 && (
          <div className="py-12 text-center text-sm" style={{ color: "#555" }}>
            No activity matches your filters
          </div>
        )}
      </div>

      <div className="mt-5 p-4 rounded-lg" style={{ background: "#1a1a1d", border: "1px solid #222" }}>
        <p className="text-xs leading-relaxed" style={{ color: "#777" }}>
          Every change flows through this app, giving you a full audit trail with user attribution — something you don't get when multiple people share a Semrush login. In production, this log persists to a database and is exportable for C-suite reporting.
        </p>
      </div>
    </>
  );
}

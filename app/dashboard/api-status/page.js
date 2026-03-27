"use client";

import { useState, useEffect } from "react";

export default function ApiStatusPage() {
  const [apiStatus, setApiStatus] = useState(null);
  const [dbStatus, setDbStatus] = useState(null);
  const [lastPing, setLastPing] = useState("Checking...");
  const [dbInitializing, setDbInitializing] = useState(false);

  useEffect(() => {
    fetch("/api/semrush/token")
      .then((res) => res.json())
      .then((data) => { setApiStatus(data); setLastPing("Just now"); })
      .catch(() => { setApiStatus({ connected: false, mode: "error" }); setLastPing("Failed"); });

    fetch("/api/db")
      .then((res) => res.json())
      .then((data) => setDbStatus(data))
      .catch(() => setDbStatus({ hasPostgres: false, mode: "memory" }));

    const interval = setInterval(() => {
      fetch("/api/semrush/token").then((res) => res.json()).then((data) => { setApiStatus(data); setLastPing("Just now"); });
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  const initDb = async () => {
    setDbInitializing(true);
    try {
      const res = await fetch("/api/db", { method: "POST" });
      const data = await res.json();
      setDbStatus({ ...dbStatus, initialized: data.initialized, initResult: data });
    } catch { }
    setDbInitializing(false);
  };

  const isLive = apiStatus?.connected && apiStatus?.mode === "live";

  const endpoints = [
    { method: "GET", path: "/external/locations/:locationId", rate: "10 req/sec", desc: "Get a single location by ID", status: "ok" },
    { method: "GET", path: "/external/locations", rate: "10 req/sec", desc: "List all locations (paginated)", status: "ok" },
    { method: "PUT", path: "/external/locations/:locationId", rate: "5 req/sec", desc: "Update a single location", status: "ok" },
    { method: "PUT", path: "/external/locations", rate: "5 req/min", desc: "Bulk update up to 50 locations", status: "ok" },
  ];

  const methodColors = { GET: "#34d399", PUT: "#fbbf24", POST: "#93c5fd", DELETE: "#f87171" };

  return (
    <>
      <div className="mb-6">
        <h2 className="text-lg font-bold text-white">API Connection Status</h2>
        <p className="text-xs mt-0.5" style={{ color: "#666" }}>
          Semrush Listing Management API health and architecture overview
        </p>
      </div>

      {/* Status cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {[
          { label: "Bearer Token", value: isLive ? "Active" : "Not Set", detail: isLive && apiStatus?.expiresAt ? `Expires ${new Date(apiStatus.expiresAt).toLocaleDateString()}` : "Set SEMRUSH_BEARER_TOKEN in .env.local", color: isLive ? "#34d399" : "#fbbf24" },
          { label: "API Mode", value: isLive ? "Live" : "Demo", detail: isLive ? "Pulling from Semrush API" : "Using demo data", color: isLive ? "#34d399" : "#fbbf24" },
          { label: "Last Check", value: lastPing, detail: "Polled every 60 seconds", color: apiStatus ? "#34d399" : "#f87171" },
          { label: "Database", value: dbStatus?.hasPostgres ? "Postgres" : "Memory", detail: dbStatus?.hasPostgres ? "Vercel Postgres connected" : "In-memory (resets on cold start)", color: dbStatus?.hasPostgres ? "#34d399" : "#fbbf24" },
        ].map((card) => (
          <div key={card.label} className="p-4 rounded-lg" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
            <div className="flex justify-between items-center mb-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "#666" }}>
                {card.label}
              </span>
              <span className="w-2 h-2 rounded-full pulse-dot" style={{ background: card.color }} />
            </div>
            <div className="text-xl font-bold text-white">{card.value}</div>
            <div className="text-[11px] mt-0.5" style={{ color: "#555" }}>{card.detail}</div>
          </div>
        ))}
      </div>

      {/* Database section */}
      <div className="rounded-xl p-5 mb-6" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
        <h3 className="text-xs font-bold uppercase tracking-wider mb-4" style={{ color: "#aaa" }}>
          Database Storage
        </h3>
        {dbStatus?.hasPostgres ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full" style={{ background: "#34d399" }} />
              <span className="text-sm text-white font-semibold">Vercel Postgres connected</span>
            </div>
            <p className="text-xs" style={{ color: "#888" }}>
              Users and activity log persist across deployments and cold starts.
            </p>
            <button
              onClick={initDb}
              disabled={dbInitializing}
              className="px-4 py-2 rounded-md text-xs font-semibold transition-opacity"
              style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#aaa", opacity: dbInitializing ? 0.6 : 1 }}
            >
              {dbInitializing ? "Initializing..." : "Initialize / Reset Database"}
            </button>
            {dbStatus?.initResult && (
              <div className="text-[11px] px-3 py-2 rounded" style={{ background: dbStatus.initResult.initialized ? "#0d281820" : "#2d0a0a20", color: dbStatus.initResult.initialized ? "#34d399" : "#f87171", border: `1px solid ${dbStatus.initResult.initialized ? "#2d5a2d40" : "#5c1a1a40"}` }}>
                {dbStatus.initResult.initialized ? "Tables created and seed data loaded." : `Error: ${dbStatus.initResult.reason}`}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full" style={{ background: "#fbbf24" }} />
              <span className="text-sm text-white font-semibold">In-memory storage</span>
            </div>
            <p className="text-xs" style={{ color: "#888" }}>
              Users and activity are stored in memory. They persist across page navigations but reset when the serverless function cold starts.
            </p>
            <div className="text-xs leading-relaxed p-3 rounded" style={{ background: "#1a1a1d", border: "1px solid #222", color: "#777" }}>
              <strong style={{ color: "#aaa" }}>To enable persistent storage:</strong>
              <br />1. In Vercel dashboard: Storage → Create Database → Postgres
              <br />2. Link the database to this project
              <br />3. Run <span className="font-mono" style={{ color: "#93c5fd" }}>vercel env pull .env.local</span> to get credentials locally
              <br />4. Redeploy, then click "Initialize Database" on this page
            </div>
          </div>
        )}
      </div>

      {/* Endpoints */}
      <div className="rounded-xl p-5 mb-6" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
        <h3 className="text-xs font-bold uppercase tracking-wider mb-4" style={{ color: "#aaa" }}>
          API Endpoints
        </h3>
        <div className="space-y-2.5">
          {endpoints.map((ep, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3 rounded-lg" style={{ background: "#1a1a1d", border: "1px solid #222" }}>
              <span className="font-mono text-xs font-bold px-2 py-0.5 rounded" style={{ color: methodColors[ep.method], background: methodColors[ep.method] + "15" }}>
                {ep.method}
              </span>
              <span className="font-mono text-xs flex-1" style={{ color: "#ccc" }}>{ep.path}</span>
              <span className="text-[11px] font-medium hidden sm:block" style={{ color: "#666" }}>{ep.desc}</span>
              <span className="text-[11px] font-mono" style={{ color: "#555" }}>{ep.rate}</span>
              <span className="w-2 h-2 rounded-full" style={{ background: "#34d399" }} />
            </div>
          ))}
        </div>
        <div className="mt-3 text-[11px]" style={{ color: "#555" }}>
          Listing Management API requests do not consume API units — included with Local Pro/Business plan.
        </div>
      </div>

      {/* Architecture diagram */}
      <div className="rounded-xl p-5 mb-6" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
        <h3 className="text-xs font-bold uppercase tracking-wider mb-4" style={{ color: "#aaa" }}>
          System Architecture
        </h3>
        <div className="font-mono text-xs leading-loose" style={{ color: "#888" }}>
          <div className="grid grid-cols-1 gap-4">
            {/* Flow visualization */}
            <div className="p-5 rounded-lg space-y-5" style={{ background: "#111113", border: "1px solid #1e1e22" }}>
              {/* Team layer */}
              <div className="flex items-center gap-3">
                <div className="px-3 py-2 rounded-md text-center" style={{ background: "#f472b620", border: "1px solid #f472b640", color: "#f472b6", minWidth: "140px" }}>
                  <div className="text-[10px] uppercase tracking-wider font-bold mb-0.5">Team Members</div>
                  <div className="text-[10px] font-normal" style={{ color: "#f472b6aa" }}>Unlimited users</div>
                </div>
                <div className="flex-1 border-t border-dashed" style={{ borderColor: "#333" }} />
                <span className="text-[10px]" style={{ color: "#555" }}>Browser / Auth</span>
              </div>

              <div className="flex justify-center">
                <span style={{ color: "#555" }}>↓</span>
              </div>

              {/* Auth layer */}
              <div className="flex items-center gap-3">
                <div className="px-3 py-2 rounded-md text-center" style={{ background: "#a78bfa20", border: "1px solid #a78bfa40", color: "#a78bfa", minWidth: "140px" }}>
                  <div className="text-[10px] uppercase tracking-wider font-bold mb-0.5">Auth Provider</div>
                  <div className="text-[10px] font-normal" style={{ color: "#a78bfaaa" }}>SSO / OAuth / JWT</div>
                </div>
                <div className="flex-1 border-t border-dashed" style={{ borderColor: "#333" }} />
                <span className="text-[10px]" style={{ color: "#555" }}>Role-based access</span>
              </div>

              <div className="flex justify-center">
                <span style={{ color: "#555" }}>↓</span>
              </div>

              {/* App layer */}
              <div className="flex items-center gap-3">
                <div className="px-3 py-2 rounded-md text-center" style={{ background: "#6ee7b720", border: "1px solid #6ee7b740", color: "#6ee7b7", minWidth: "140px" }}>
                  <div className="text-[10px] uppercase tracking-wider font-bold mb-0.5">This App</div>
                  <div className="text-[10px] font-normal" style={{ color: "#6ee7b7aa" }}>Next.js on Vercel</div>
                </div>
                <div className="flex-1 border-t border-dashed" style={{ borderColor: "#333" }} />
                <span className="text-[10px]" style={{ color: "#555" }}>API routes proxy requests</span>
              </div>

              <div className="flex justify-center">
                <span style={{ color: "#555" }}>↓</span>
              </div>

              {/* Database layer */}
              <div className="flex items-center gap-3">
                <div className="px-3 py-2 rounded-md text-center" style={{ background: "#93c5fd20", border: "1px solid #93c5fd40", color: "#93c5fd", minWidth: "140px" }}>
                  <div className="text-[10px] uppercase tracking-wider font-bold mb-0.5">Vercel Postgres</div>
                  <div className="text-[10px] font-normal" style={{ color: "#93c5fdaa" }}>Users + Activity Log</div>
                </div>
                <div className="flex-1 border-t border-dashed" style={{ borderColor: "#333" }} />
                <span className="text-[10px]" style={{ color: "#555" }}>Persistent storage</span>
              </div>

              <div className="flex justify-center">
                <span style={{ color: "#555" }}>↓</span>
              </div>

              {/* Token layer */}
              <div className="flex items-center gap-3">
                <div className="px-3 py-2 rounded-md text-center" style={{ background: "#fbbf2420", border: "1px solid #fbbf2440", color: "#fbbf24", minWidth: "140px" }}>
                  <div className="text-[10px] uppercase tracking-wider font-bold mb-0.5">Bearer Token</div>
                  <div className="text-[10px] font-normal" style={{ color: "#fbbf24aa" }}>Server-side only</div>
                </div>
                <div className="flex-1 border-t border-dashed" style={{ borderColor: "#333" }} />
                <span className="text-[10px]" style={{ color: "#555" }}>Single API credential</span>
              </div>

              <div className="flex justify-center">
                <span style={{ color: "#555" }}>↓</span>
              </div>

              {/* Semrush layer */}
              <div className="flex items-center gap-3">
                <div className="px-3 py-2 rounded-md text-center" style={{ background: "#f9731620", border: "1px solid #f9731640", color: "#f97316", minWidth: "140px" }}>
                  <div className="text-[10px] uppercase tracking-wider font-bold mb-0.5">Semrush API</div>
                  <div className="text-[10px] font-normal" style={{ color: "#f97316aa" }}>Listing Management</div>
                </div>
                <div className="flex-1 border-t border-dashed" style={{ borderColor: "#333" }} />
                <span className="text-[10px]" style={{ color: "#555" }}>→ 70+ directories</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Cost comparison */}
      <div className="rounded-xl p-5" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
        <h3 className="text-xs font-bold uppercase tracking-wider mb-4" style={{ color: "#aaa" }}>
          Cost Comparison — Per-Seat vs. API Bridge
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="p-4 rounded-lg" style={{ background: "#2d0a0a30", border: "1px solid #5c1a1a40" }}>
            <div className="text-xs font-bold mb-2" style={{ color: "#f87171" }}>Direct Semrush Seats</div>
            <div className="space-y-1.5 text-xs" style={{ color: "#999" }}>
              <div className="flex justify-between">
                <span>5 users × Semrush seat cost</span>
                <span style={{ color: "#f87171" }}>$$$$</span>
              </div>
              <div className="flex justify-between">
                <span>No audit trail</span>
                <span style={{ color: "#f87171" }}>✗</span>
              </div>
              <div className="flex justify-between">
                <span>No brand-level permissions</span>
                <span style={{ color: "#f87171" }}>✗</span>
              </div>
              <div className="flex justify-between">
                <span>No bulk automation</span>
                <span style={{ color: "#f87171" }}>✗</span>
              </div>
            </div>
          </div>
          <div className="p-4 rounded-lg" style={{ background: "#0d281830", border: "1px solid #2d5a2d40" }}>
            <div className="text-xs font-bold mb-2" style={{ color: "#34d399" }}>API Bridge (This App)</div>
            <div className="space-y-1.5 text-xs" style={{ color: "#999" }}>
              <div className="flex justify-between">
                <span>1 Local Pro plan + Vercel free tier</span>
                <span style={{ color: "#34d399" }}>$</span>
              </div>
              <div className="flex justify-between">
                <span>Full audit trail with user attribution</span>
                <span style={{ color: "#34d399" }}>✓</span>
              </div>
              <div className="flex justify-between">
                <span>Brand-level role permissions</span>
                <span style={{ color: "#34d399" }}>✓</span>
              </div>
              <div className="flex justify-between">
                <span>Bulk updates across hundreds of locations</span>
                <span style={{ color: "#34d399" }}>✓</span>
              </div>
              <div className="flex justify-between">
                <span>Persistent Postgres storage</span>
                <span style={{ color: "#34d399" }}>✓</span>
              </div>
              <div className="flex justify-between">
                <span>Directory sync error monitoring</span>
                <span style={{ color: "#34d399" }}>✓</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

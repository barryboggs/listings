"use client";

import { useState, useEffect, createContext, useContext } from "react";
import { useRouter, usePathname } from "next/navigation";

const UserContext = createContext(null);
export function useUser() {
  return useContext(UserContext);
}

const NAV_ITEMS = [
  { href: "/dashboard", icon: "◉", label: "Locations" },
  { href: "/dashboard/activity", icon: "◷", label: "Activity Log" },
  { href: "/dashboard/api-status", icon: "⟡", label: "API Status" },
];

const ADMIN_NAV = [
  { href: "/dashboard/admin", icon: "⚙", label: "User Management" },
];

export default function DashboardLayout({ children }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [apiMode, setApiMode] = useState(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((res) => res.json())
      .then((data) => {
        if (data.user) {
          setUser(data.user);
        } else {
          router.push("/login");
        }
        setLoading(false);
      })
      .catch(() => {
        router.push("/login");
        setLoading(false);
      });

    // Check API mode
    fetch("/api/semrush/token")
      .then((res) => res.json())
      .then((data) => setApiMode(data.mode))
      .catch(() => setApiMode("demo"));
  }, [router]);

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "#111113" }}>
        <div className="text-sm" style={{ color: "#666" }}>Loading...</div>
      </div>
    );
  }

  if (!user) return null;

  const navItems = user.role === "admin" ? [...NAV_ITEMS, ...ADMIN_NAV] : NAV_ITEMS;

  return (
    <UserContext.Provider value={user}>
      <div className="min-h-screen" style={{ background: "#111113" }}>
        {/* Header */}
        <header
          className="flex justify-between items-center px-5 lg:px-7 py-3.5"
          style={{ borderBottom: "1px solid #1e1e22" }}
        >
          <div className="flex items-center gap-4">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="lg:hidden p-1.5 rounded"
              style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#888" }}
            >
              ☰
            </button>
            <div>
              <h1 className="text-base font-bold tracking-tight text-white flex items-center gap-2.5">
                <span className="flex gap-0.5">
                  <span className="w-2 h-2 rounded-sm" style={{ background: "#E31837" }} />
                  <span className="w-2 h-2 rounded-sm" style={{ background: "#0066CC" }} />
                  <span className="w-2 h-2 rounded-sm" style={{ background: "#00875A" }} />
                </span>
                Listing Manager
              </h1>
              <p className="text-xs mt-0.5" style={{ color: "#555" }}>
                Driven Brands → Semrush API Bridge
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div
              className="px-3 py-1 rounded text-xs font-semibold flex items-center gap-1.5"
              style={{
                background: apiMode === "live" ? "#1a2e1a" : "#2d1b00",
                border: `1px solid ${apiMode === "live" ? "#2d5a2d" : "#5c3a00"}`,
                color: apiMode === "live" ? "#6ee7b7" : "#fbbf24",
              }}
            >
              <span className="w-1.5 h-1.5 rounded-full pulse-dot" style={{ background: apiMode === "live" ? "#34d399" : "#fbbf24" }} />
              {apiMode === "live" ? "API Live" : "Demo Mode"}
            </div>
            <div className="flex items-center gap-2">
              <div
                className="w-8 h-8 rounded-md flex items-center justify-center text-xs font-bold"
                style={{ background: "#222", border: "1px solid #333", color: "#aaa" }}
              >
                {user.initials}
              </div>
              <div className="hidden sm:block">
                <div className="text-xs font-semibold text-white">{user.name}</div>
                <div className="text-xs capitalize" style={{ color: "#666" }}>{user.role}</div>
              </div>
              <button
                onClick={handleLogout}
                className="ml-2 text-xs px-2.5 py-1 rounded"
                style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#888" }}
              >
                Sign Out
              </button>
            </div>
          </div>
        </header>

        <div className="flex" style={{ height: "calc(100vh - 57px)" }}>
          {/* Sidebar */}
          <aside
            className={`${
              sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
            } fixed lg:relative z-30 lg:z-auto w-56 lg:w-56 flex-shrink-0 transition-transform duration-200`}
            style={{
              borderRight: "1px solid #1e1e22",
              background: "#111113",
              height: "calc(100vh - 57px)",
            }}
          >
            <div className="p-4 flex flex-col h-full">
              <span
                className="text-[10px] font-bold tracking-widest uppercase px-2 mb-2"
                style={{ color: "#555" }}
              >
                Navigation
              </span>
              <div className="space-y-0.5">
                {navItems.map((item) => {
                  const isActive = pathname === item.href;
                  return (
                    <a
                      key={item.href}
                      href={item.href}
                      className="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors"
                      style={{
                        background: isActive ? "#1c1c1f" : "transparent",
                        border: isActive ? "1px solid #2a2a2e" : "1px solid transparent",
                        color: isActive ? "#e8e8e8" : "#777",
                      }}
                    >
                      <span className="text-sm opacity-80">{item.icon}</span>
                      {item.label}
                    </a>
                  );
                })}
              </div>

              {/* API Info */}
              <div
                className="mt-auto p-3 rounded-lg"
                style={{ background: "#1a1a1d", border: "1px solid #222" }}
              >
                <div
                  className="text-[10px] font-bold uppercase tracking-wider mb-2"
                  style={{ color: "#888" }}
                >
                  API Endpoints
                </div>
                <div className="font-mono text-[11px] leading-relaxed" style={{ color: "#555" }}>
                  <div>GetLocation</div>
                  <div>GetLocations</div>
                  <div>UpdateLocation</div>
                  <div>UpdateLocations</div>
                </div>
                <div className="text-[10px] mt-2" style={{ color: "#444" }}>
                  GET: 10 req/sec · PUT: 5 req/sec
                  <br />
                  Bulk: 5 req/min, max 50
                </div>
              </div>
            </div>
          </aside>

          {/* Mobile sidebar overlay */}
          {sidebarOpen && (
            <div
              className="fixed inset-0 bg-black/50 z-20 lg:hidden"
              onClick={() => setSidebarOpen(false)}
            />
          )}

          {/* Main content */}
          <main className="flex-1 overflow-auto p-5 lg:p-7">{children}</main>
        </div>
      </div>
    </UserContext.Provider>
  );
}
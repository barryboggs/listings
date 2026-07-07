"use client";

import { useState, useEffect, createContext, useContext } from "react";
import { useRouter, usePathname } from "next/navigation";

const UserContext = createContext(null);
export function useUser() {
  return useContext(UserContext);
}

const NAV_ITEMS = [
  { href: "/dashboard", icon: "◉", label: "Locations" },
  { href: "/dashboard/health", icon: "▲", label: "Listing Health" },
  { href: "/dashboard/pending-approval", icon: "⌛", label: "Pending Approval" },
  { href: "/dashboard/holiday-import", icon: "📅", label: "Holiday Import" },
  { href: "/dashboard/listings-photos", icon: "🖼", label: "Listing Photos" },
  { href: "/dashboard/activity", icon: "◷", label: "Activity Log" },
  { href: "/dashboard/api-status", icon: "⟡", label: "API Status" },
];

const ADMIN_NAV = [
  { href: "/dashboard/admin", icon: "⚙", label: "User Management" },
  { href: "/dashboard/shops", icon: "#", label: "Shop Numbers" },
];

/**
 * API-health badge. Post-migration, the app talks to one API (Semrush's
 * "rich" API, Apikey auth), so this reflects the live state of that API.
 *
 * Visual states:
 *   - "API Live"    green   — most recent call succeeded
 *   - "API Error"   red     — most recent call failed
 *   - "Demo Mode"   yellow  — no SEMRUSH_API_KEY configured
 *   - "API ready"   blue    — key configured, no calls have flowed yet
 *   - "Checking…"   gray    — initial load
 *
 * Hovering shows the most recent error message (if any).
 */
function ApiHealthBadge({ health }) {
  if (!health) {
    return (
      <div className="px-3 py-1 rounded text-xs font-semibold flex items-center gap-1.5"
        style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#888" }}>
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: "#666" }} />
        Checking…
      </div>
    );
  }

  const rich = health.richApi || {};
  let label, dot, bg, border, color, tooltip;

  if (!rich.hasKey) {
    label = "Demo Mode";
    dot = "#fbbf24";
    bg = "#2d1b00";
    border = "#5c3a00";
    color = "#fbbf24";
    tooltip = "SEMRUSH_API_KEY not configured — using seed data";
  } else if (rich.state === "failing") {
    label = "API Error";
    dot = "#f87171";
    bg = "#2d0a0a";
    border = "#5c1a1a";
    color = "#f87171";
    tooltip = rich.lastErrorMessage || "Last Semrush call failed";
  } else if (rich.state === "healthy") {
    label = "API Live";
    dot = "#34d399";
    bg = "#1a2e1a";
    border = "#2d5a2d";
    color = "#6ee7b7";
    tooltip = "Semrush API responding";
  } else {
    label = "API ready";
    dot = "#93c5fd";
    bg = "#0c1a2e";
    border = "#1e3a5f";
    color = "#93c5fd";
    tooltip = "API key configured — no calls have flowed yet from this worker";
  }

  return (
    <div
      title={tooltip}
      className="px-3 py-1 rounded text-xs font-semibold flex items-center gap-1.5 cursor-help"
      style={{ background: bg, border: `1px solid ${border}`, color }}
    >
      <span className="w-1.5 h-1.5 rounded-full pulse-dot" style={{ background: dot }} />
      {label}
    </div>
  );
}

export default function DashboardLayout({ children }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [apiHealth, setApiHealth] = useState(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((res) => res.json())
      .then((data) => {
        if (data.user) {
          setUser(data.user);
          // Force a password change if the admin-set temp password is
          // still in place. The /dashboard/account page handles the flow;
          // we route there from anywhere else.
          if (data.user.passwordTemp && pathname !== "/dashboard/account") {
            router.replace("/dashboard/account");
          }
        } else {
          router.push("/login");
        }
        setLoading(false);
      })
      .catch(() => {
        router.push("/login");
        setLoading(false);
      });

    // Check actual API health (not just whether credentials are configured).
    // Polled once on mount; refreshing /dashboard re-runs this. The endpoint
    // reports per-API health based on whether the most recent call succeeded.
    fetch("/api/semrush/token")
      .then((res) => res.json())
      .then((data) => setApiHealth(data))
      .catch(() => setApiHealth({ oldApi: { state: "no_token" }, richApi: { state: "no_key" } }));
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
            <ApiHealthBadge health={apiHealth} />
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
              <a
                href="/dashboard/account"
                className="ml-2 text-xs px-2.5 py-1 rounded"
                style={{
                  background: pathname === "/dashboard/account" ? "#1c1c1f" : "transparent",
                  border: "1px solid #2a2a2e",
                  color: pathname === "/dashboard/account" ? "#e8e8e8" : "#888",
                  textDecoration: "none",
                }}
              >
                Account
              </a>
              <button
                onClick={handleLogout}
                className="text-xs px-2.5 py-1 rounded"
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

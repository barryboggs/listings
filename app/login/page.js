"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Login failed");
        setLoading(false);
        return;
      }

      router.push("/dashboard");
      router.refresh();
    } catch {
      setError("Network error — please try again");
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ background: "#111113" }}>
      <div className="w-full max-w-sm animate-fade-in">
        {/* Logo area */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-3 mb-3">
            <div className="flex gap-1">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: "#E31837" }} />
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: "#0066CC" }} />
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: "#00875A" }} />
            </div>
          </div>
          <h1 className="text-xl font-bold tracking-tight text-white">Listing Manager</h1>
          <p className="text-xs mt-1.5" style={{ color: "#666" }}>
            Driven Brands — Semrush API Bridge
          </p>
        </div>

        {/* Login form */}
        <div
          className="rounded-xl p-6"
          style={{ background: "#151517", border: "1px solid #1e1e22" }}
        >
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold mb-1.5 uppercase tracking-wider" style={{ color: "#777" }}>
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@drivenbrands.com"
                required
                className="w-full px-3 py-2.5 rounded-lg text-sm"
                style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }}
              />
            </div>

            <div>
              <label className="block text-xs font-semibold mb-1.5 uppercase tracking-wider" style={{ color: "#777" }}>
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                className="w-full px-3 py-2.5 rounded-lg text-sm"
                style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }}
              />
            </div>

            {error && (
              <div
                className="text-xs px-3 py-2 rounded-md"
                style={{ background: "#2d0a0a", border: "1px solid #5c1a1a", color: "#f87171" }}
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 rounded-lg text-sm font-semibold transition-opacity"
              style={{
                background: "#E31837",
                color: "#fff",
                opacity: loading ? 0.7 : 1,
              }}
            >
              {loading ? "Signing in..." : "Sign In"}
            </button>
          </form>
        </div>

        {/* Demo credentials */}
        <div
          className="mt-5 rounded-lg p-4"
          style={{ background: "#1a1a1d", border: "1px solid #222" }}
        >
          <p className="text-xs font-semibold mb-2 uppercase tracking-wider" style={{ color: "#666" }}>
            Demo Accounts
          </p>
          <div className="space-y-1.5 font-mono text-xs" style={{ color: "#888" }}>
            <div className="flex justify-between">
              <span>admin@drivenbrands.com</span>
              <span style={{ color: "#555" }}>admin123</span>
            </div>
            <div className="flex justify-between">
              <span>barry@drivenbrands.com</span>
              <span style={{ color: "#555" }}>demo123</span>
            </div>
            <div className="flex justify-between">
              <span>maria@drivenbrands.com</span>
              <span style={{ color: "#555" }}>demo123</span>
            </div>
          </div>
          <p className="text-xs mt-3" style={{ color: "#555" }}>
            Admin account has full access including user management.
          </p>
        </div>
      </div>
    </div>
  );
}

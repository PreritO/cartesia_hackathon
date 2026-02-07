/**
 * URLInput - Landing page where users paste a YouTube URL to start commentary.
 */

import { useState } from "react";

interface SessionInfo {
  sessionId: string;
  title: string;
  duration: number;
  videoUrl: string;
}

interface URLInputProps {
  onSessionCreated: (session: SessionInfo) => void;
}

export function URLInput({ onSessionCreated }: URLInputProps) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const handleStart = async () => {
    if (!url.trim()) {
      setError("Please paste a YouTube URL");
      return;
    }

    setLoading(true);
    setError(null);
    setStatus("Downloading video...");

    try {
      const res = await fetch("/api/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.detail || `Server error: ${res.status}`);
      }

      const data = await res.json();
      setStatus(`Ready: ${data.title}`);

      onSessionCreated({
        sessionId: data.session_id,
        title: data.title,
        duration: data.duration,
        videoUrl: data.video_url,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start");
      setLoading(false);
      setStatus(null);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-gray-950">
      <div className="w-full max-w-lg px-6">
        <div className="mb-8 text-center">
          <h1 className="mb-2 text-3xl font-bold text-white">
            AI Sports Commentator
          </h1>
          <p className="text-sm text-gray-400">
            Paste a YouTube sports highlight link and get live AI commentary
          </p>
        </div>

        <div className="space-y-4">
          <input
            type="text"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && !loading && handleStart()}
            placeholder="https://www.youtube.com/watch?v=..."
            disabled={loading}
            className="w-full rounded-lg border border-gray-700 bg-gray-900 px-4 py-3 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none disabled:opacity-50"
          />

          <button
            onClick={handleStart}
            disabled={loading || !url.trim()}
            className="w-full rounded-lg bg-blue-600 px-4 py-3 font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Downloading..." : "Start Commentary"}
          </button>

          {error && (
            <p className="text-center text-sm text-red-400">{error}</p>
          )}

          {status && !error && (
            <p className="text-center text-sm text-gray-400">{status}</p>
          )}
        </div>

        <div className="mt-8 text-center text-xs text-gray-600">
          Supports YouTube videos up to 10 minutes. NFL, NBA, soccer highlights
          work great.
        </div>
      </div>
    </div>
  );
}

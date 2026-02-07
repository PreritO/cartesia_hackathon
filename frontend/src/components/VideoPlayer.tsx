/**
 * VideoPlayer - Plays the downloaded video with commentary overlay and TTS audio.
 *
 * Connects to the backend WebSocket to receive commentary text and audio.
 * Plays the video from the backend's static file server.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CommentaryOverlay } from "./CommentaryOverlay";

interface VideoPlayerProps {
  sessionId: string;
  title: string;
  videoUrl: string;
  onBack: () => void;
}

interface CommentaryItem {
  id: number;
  text: string;
  emotion: string;
  timestamp: number;
}

export function VideoPlayer({
  sessionId,
  title,
  videoUrl,
  onBack,
}: VideoPlayerProps) {
  const [commentary, setCommentary] = useState<CommentaryItem[]>([]);
  const [status, setStatus] = useState("Connecting...");
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextIdRef = useRef(0);

  const playAudio = useCallback(async (base64Audio: string) => {
    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext();
      }
      const ctx = audioContextRef.current;

      // Resume if suspended (browser autoplay policy)
      if (ctx.state === "suspended") {
        await ctx.resume();
      }

      const binaryStr = atob(base64Audio);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      const audioBuffer = await ctx.decodeAudioData(bytes.buffer);
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      source.start();
    } catch (err) {
      console.warn("Audio playback error:", err);
    }
  }, []);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws/${sessionId}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setStatus("Connected");
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === "status") {
        setStatus(msg.message);
      } else if (msg.type === "commentary") {
        const item: CommentaryItem = {
          id: nextIdRef.current++,
          text: msg.text,
          emotion: msg.emotion || "neutral",
          timestamp: Date.now(),
        };
        setCommentary((prev) => [...prev.slice(-4), item]);

        // Play TTS audio
        if (msg.audio) {
          playAudio(msg.audio);
        }
      }
    };

    ws.onerror = () => {
      setStatus("Connection error");
      setConnected(false);
    };

    ws.onclose = () => {
      setConnected(false);
      setStatus("Disconnected");
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [sessionId, playAudio]);

  // Clean up audio context on unmount
  useEffect(() => {
    return () => {
      audioContextRef.current?.close();
    };
  }, []);

  return (
    <div className="flex h-screen flex-col bg-gray-950">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-800 px-4 py-2">
        <button
          onClick={onBack}
          className="rounded px-3 py-1 text-sm text-gray-400 transition hover:bg-gray-800 hover:text-white"
        >
          &larr; Back
        </button>
        <div className="text-sm text-gray-400 truncate max-w-md">{title}</div>
        <div className="flex items-center gap-2">
          <div
            className={`h-2 w-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`}
          />
          <span className="text-xs text-gray-500">{status}</span>
        </div>
      </div>

      {/* Video + Commentary */}
      <div className="relative flex-1">
        <video
          src={videoUrl}
          controls
          autoPlay
          className="h-full w-full object-contain bg-black"
          onClick={() => {
            // Ensure audio context is resumed on user interaction
            if (audioContextRef.current?.state === "suspended") {
              audioContextRef.current.resume();
            }
          }}
        />

        <CommentaryOverlay items={commentary} />
      </div>
    </div>
  );
}

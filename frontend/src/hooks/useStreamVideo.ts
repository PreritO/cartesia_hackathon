/**
 * useStreamVideo - Hook for managing Stream Video SDK connection.
 *
 * Creates a StreamVideoClient using environment variables:
 *   VITE_STREAM_API_KEY   (required) - Your Stream API key
 *   VITE_STREAM_USER_TOKEN (optional) - Pre-generated user token for authenticated mode
 *
 * If no token is provided, connects as a guest user (no backend needed).
 * Add these to frontend/.env (not committed to git).
 */

import { useEffect, useState } from "react";
import { StreamVideoClient } from "@stream-io/video-react-sdk";

const API_KEY = import.meta.env.VITE_STREAM_API_KEY as string | undefined;
const USER_TOKEN = import.meta.env.VITE_STREAM_USER_TOKEN as
  | string
  | undefined;

const USER_ID = "viewer";
const USER_NAME = "Viewer";

export function useStreamVideo(): {
  client: StreamVideoClient | null;
  isReady: boolean;
} {
  const [client, setClient] = useState<StreamVideoClient | null>(null);

  useEffect(() => {
    if (!API_KEY) {
      console.error(
        "[useStreamVideo] VITE_STREAM_API_KEY is not set. " +
          "Create frontend/.env with VITE_STREAM_API_KEY=your_key"
      );
      return;
    }

    let videoClient: StreamVideoClient;

    if (USER_TOKEN) {
      // Authenticated user mode: use a pre-generated token
      videoClient = new StreamVideoClient({
        apiKey: API_KEY,
        user: { id: USER_ID, name: USER_NAME },
        token: USER_TOKEN,
      });
    } else {
      // Guest user mode: no token required, SDK handles auth internally
      videoClient = new StreamVideoClient({
        apiKey: API_KEY,
        user: { id: USER_ID, name: USER_NAME, type: "guest" as const },
      });
    }

    setClient(videoClient);

    return () => {
      videoClient.disconnectUser();
      setClient(null);
    };
  }, []);

  return { client, isReady: client !== null };
}

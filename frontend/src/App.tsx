/**
 * App - Main entry point for the AI Sports Commentator frontend.
 *
 * P0 MVP: Joins a Stream Video call and displays video/audio from
 * the AI commentator agent. No profile setup or commentary overlay yet.
 *
 * Usage:
 *   Open http://localhost:5173/?callId=your-call-id
 *   If no callId param is provided, defaults to "sports-commentator-dev".
 */

import { StreamVideo } from "@stream-io/video-react-sdk";
import "@stream-io/video-react-sdk/dist/css/styles.css";

import { useStreamVideo } from "./hooks/useStreamVideo.ts";
import { VideoRoom } from "./components/VideoRoom.tsx";

const DEFAULT_CALL_ID = "sports-commentator-dev";

function getCallId(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("callId") || DEFAULT_CALL_ID;
}

function App() {
  const { client, isReady } = useStreamVideo();
  const callId = getCallId();

  if (!isReady || !client) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-950 text-white">
        <div className="text-center">
          <div className="mb-4 text-2xl font-bold">
            AI Sports Commentator
          </div>
          <div className="text-sm text-gray-400">
            Initializing Stream Video...
          </div>
        </div>
      </div>
    );
  }

  return (
    <StreamVideo client={client}>
      <VideoRoom client={client} callId={callId} />
    </StreamVideo>
  );
}

export default App;

/**
 * App - Main entry point for the AI Sports Commentator frontend.
 *
 * Flow:
 *   1. User pastes a YouTube URL and clicks "Start Commentary"
 *   2. Backend downloads the video and returns session info
 *   3. Video plays in an embedded player with commentary overlay + TTS audio
 */

import { useState } from "react";
import { URLInput } from "./components/URLInput";
import { VideoPlayer } from "./components/VideoPlayer";

interface SessionInfo {
  sessionId: string;
  title: string;
  duration: number;
  videoUrl: string;
}

function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);

  if (!session) {
    return <URLInput onSessionCreated={setSession} />;
  }

  return (
    <VideoPlayer
      sessionId={session.sessionId}
      title={session.title}
      videoUrl={session.videoUrl}
      onBack={() => setSession(null)}
    />
  );
}

export default App;

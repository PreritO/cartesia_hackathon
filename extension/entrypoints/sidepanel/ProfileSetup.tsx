import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserProfileData {
  name: string;
  favorite_team: string | null;
  rival_team: string | null;
  expertise_slider: number;
  hot_take_slider: number;
  voice_key: string;
  favorite_players: string[];
  interests: string[];
}

export interface ProfileSetupProps {
  onComplete: (profile: UserProfileData) => void;
  onSkip: () => void;
}

interface ChatMessage {
  role: 'assistant' | 'user';
  text: string;
}

interface ProfileChatResponse {
  text: string;
  audio: string | null;
  done: boolean;
  profile: UserProfileData | null;
}

const API_URL = 'http://localhost:8000/api/profile-chat';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProfileSetup({ onComplete, onSkip }: ProfileSetupProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const initCalledRef = useRef(false);

  // ---- Auto-scroll to latest message ----

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading, scrollToBottom]);

  // ---- API call to backend ----

  const sendToBackend = useCallback(
    async (conversationHistory: ChatMessage[]): Promise<ProfileChatResponse | null> => {
      try {
        const res = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: conversationHistory }),
        });

        if (!res.ok) {
          throw new Error(`Server responded with ${res.status}`);
        }

        return (await res.json()) as ProfileChatResponse;
      } catch (err) {
        console.error('[ProfileSetup] API error:', err);
        setError(err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    [],
  );

  // ---- Audio playback ----

  const playAudio = useCallback((base64Audio: string) => {
    try {
      const audio = new Audio(`data:audio/mp3;base64,${base64Audio}`);
      audio.play().catch((err) => {
        console.warn('[ProfileSetup] Audio playback failed:', err);
      });
    } catch (err) {
      console.warn('[ProfileSetup] Audio creation failed:', err);
    }
  }, []);

  // ---- Handle assistant response ----

  const handleAssistantResponse = useCallback(
    (response: ProfileChatResponse, currentMessages: ChatMessage[]) => {
      if (!mountedRef.current) return;

      const assistantMsg: ChatMessage = { role: 'assistant', text: response.text };
      const updatedMessages = [...currentMessages, assistantMsg];
      setMessages(updatedMessages);

      if (response.audio) {
        playAudio(response.audio);
      }

      if (response.done && response.profile) {
        // Small delay so the user sees Danny's final message before transitioning
        setTimeout(() => {
          if (mountedRef.current) {
            onComplete(response.profile!);
          }
        }, 1500);
      }
    },
    [onComplete, playAudio],
  );

  // ---- Initial greeting on mount ----

  useEffect(() => {
    mountedRef.current = true;

    if (initCalledRef.current) return;
    initCalledRef.current = true;

    async function fetchGreeting() {
      setIsLoading(true);
      const response = await sendToBackend([]);
      setIsLoading(false);

      if (response && mountedRef.current) {
        handleAssistantResponse(response, []);
      }
    }

    fetchGreeting();

    return () => {
      mountedRef.current = false;
    };
  }, [sendToBackend, handleAssistantResponse]);

  // ---- Send user message ----

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isLoading) return;

      setError(null);
      const userMsg: ChatMessage = { role: 'user', text: trimmed };
      const updatedMessages = [...messages, userMsg];
      setMessages(updatedMessages);
      setInputText('');
      setIsLoading(true);

      const response = await sendToBackend(updatedMessages);
      if (!mountedRef.current) return;

      setIsLoading(false);

      if (response) {
        handleAssistantResponse(response, updatedMessages);
      }

      // Refocus the input
      inputRef.current?.focus();
    },
    [messages, isLoading, sendToBackend, handleAssistantResponse],
  );

  // ---- Keyboard submit ----

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage(inputText);
      }
    },
    [inputText, sendMessage],
  );

  // ---- Microphone (webkitSpeechRecognition) ----

  const toggleRecording = useCallback(async () => {
    if (isRecording) {
      // Stop recording
      recognitionRef.current?.stop();
      setIsRecording(false);
      return;
    }

    const SpeechRecognition = (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setError('Speech recognition not supported in this browser.');
      return;
    }

    // Chrome extension side panels can't show the mic permission prompt directly.
    // Check if we already have mic access; if not, open a popup window to request it.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      // Permission not granted — open a popup window where Chrome CAN show the prompt.
      // Once granted for this extension origin, the side panel inherits access.
      try {
        await chrome.windows.create({
          url: chrome.runtime.getURL('mic-permission.html'),
          type: 'popup',
          width: 400,
          height: 300,
          focused: true,
        });
        setError('Please grant mic access in the popup window, then try again.');
      } catch (winErr) {
        console.error('[ProfileSetup] Failed to open mic permission window:', winErr);
        setError('Could not request mic access. Please enable it in Chrome settings.');
      }
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event: any) => {
      const results = event.results;
      if (results.length > 0) {
        const transcript = results[results.length - 1][0].transcript;
        setInputText(transcript);

        // If the result is final, auto-send
        if (results[results.length - 1].isFinal) {
          setIsRecording(false);
          // Use a small timeout to ensure state is updated
          setTimeout(() => {
            sendMessage(transcript);
          }, 100);
        }
      }
    };

    recognition.onerror = (event: any) => {
      console.error('[ProfileSetup] Speech recognition error:', event.error);
      setIsRecording(false);
    };

    recognition.onend = () => {
      setIsRecording(false);
    };

    recognitionRef.current = recognition;
    setIsRecording(true);
    recognition.start();
  }, [isRecording, sendMessage]);

  // ---- Render ----

  return (
    <div
      style={{
        fontFamily: 'system-ui, -apple-system, sans-serif',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: '#0f172a',
        color: 'white',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '16px 16px 12px',
          borderBottom: '1px solid #1e293b',
          flexShrink: 0,
          textAlign: 'center',
        }}
      >
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>
          Meet Your Commentator
        </h1>
        <p style={{ fontSize: 12, color: '#94a3b8', margin: '4px 0 0' }}>
          Danny wants to get to know you before the game
        </p>
      </div>

      {/* Message list */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        {messages.map((msg, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
            }}
          >
            <div
              style={{
                maxWidth: '85%',
                padding: '10px 14px',
                borderRadius: 8,
                fontSize: 13,
                lineHeight: 1.5,
                ...(msg.role === 'assistant'
                  ? {
                      background: '#1e293b',
                      borderLeft: '3px solid #7c3aed',
                      color: '#e2e8f0',
                    }
                  : {
                      background: '#334155',
                      color: '#e2e8f0',
                    }),
              }}
            >
              {msg.role === 'assistant' && (
                <div
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    color: '#7c3aed',
                    marginBottom: 4,
                    letterSpacing: '0.05em',
                  }}
                >
                  Danny
                </div>
              )}
              {msg.text}
            </div>
          </div>
        ))}

        {/* Typing indicator */}
        {isLoading && (
          <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
            <div
              style={{
                background: '#1e293b',
                borderLeft: '3px solid #7c3aed',
                borderRadius: 8,
                padding: '10px 14px',
              }}
            >
              <div
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  color: '#7c3aed',
                  marginBottom: 4,
                  letterSpacing: '0.05em',
                }}
              >
                Danny
              </div>
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <span className="typing-dot" style={{ animationDelay: '0ms' }} />
                <span className="typing-dot" style={{ animationDelay: '200ms' }} />
                <span className="typing-dot" style={{ animationDelay: '400ms' }} />
              </div>
            </div>
          </div>
        )}

        {/* Error message */}
        {error && (
          <div
            style={{
              padding: '8px 12px',
              borderRadius: 6,
              background: 'rgba(239, 68, 68, 0.15)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              color: '#fca5a5',
              fontSize: 12,
              textAlign: 'center',
            }}
          >
            {error}
          </div>
        )}

        {/* Invisible scroll anchor */}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div
        style={{
          flexShrink: 0,
          padding: '12px 16px',
          borderTop: '1px solid #1e293b',
        }}
      >
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
          }}
        >
          {/* Text input */}
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              background: '#1e293b',
              border: '1px solid #334155',
              borderRadius: 8,
              overflow: 'hidden',
            }}
          >
            <input
              ref={inputRef}
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isRecording ? 'Listening...' : 'Type your response...'}
              disabled={isLoading}
              style={{
                flex: 1,
                padding: '10px 12px',
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: '#e2e8f0',
                fontSize: 13,
              }}
            />
          </div>

          {/* Mic button */}
          <button
            onClick={toggleRecording}
            disabled={isLoading}
            title={isRecording ? 'Stop recording' : 'Start voice input'}
            style={{
              width: 40,
              height: 40,
              borderRadius: 8,
              border: 'none',
              cursor: isLoading ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              background: isRecording ? '#ef4444' : '#475569',
              transition: 'background 0.2s, transform 0.1s',
              ...(isRecording ? { animation: 'pulse-mic 1.5s ease-in-out infinite' } : {}),
            }}
          >
            {/* Microphone SVG icon */}
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="white"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          </button>

          {/* Send button */}
          <button
            onClick={() => sendMessage(inputText)}
            disabled={isLoading || !inputText.trim()}
            title="Send message"
            style={{
              width: 40,
              height: 40,
              borderRadius: 8,
              border: 'none',
              cursor: isLoading || !inputText.trim() ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              background:
                isLoading || !inputText.trim() ? '#334155' : '#7c3aed',
              transition: 'background 0.2s',
            }}
          >
            {/* Send arrow SVG icon */}
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="white"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>

        {/* Skip link */}
        <div style={{ textAlign: 'center', marginTop: 10 }}>
          <button
            onClick={onSkip}
            style={{
              background: 'none',
              border: 'none',
              color: '#64748b',
              fontSize: 12,
              cursor: 'pointer',
              padding: '4px 8px',
              transition: 'color 0.2s',
            }}
            onMouseEnter={(e) => {
              (e.target as HTMLButtonElement).style.color = '#94a3b8';
            }}
            onMouseLeave={(e) => {
              (e.target as HTMLButtonElement).style.color = '#64748b';
            }}
          >
            Skip setup and use defaults
          </button>
        </div>
      </div>

      {/* Animations */}
      <style>{`
        .typing-dot {
          display: inline-block;
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #7c3aed;
          animation: typing-bounce 1.4s ease-in-out infinite;
        }

        @keyframes typing-bounce {
          0%, 60%, 100% {
            transform: translateY(0);
            opacity: 0.4;
          }
          30% {
            transform: translateY(-6px);
            opacity: 1;
          }
        }

        @keyframes pulse-mic {
          0%, 100% {
            box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.5);
          }
          50% {
            box-shadow: 0 0 0 8px rgba(239, 68, 68, 0);
          }
        }

        input::placeholder {
          color: #64748b;
        }

        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: #475569; }
      `}</style>
    </div>
  );
}

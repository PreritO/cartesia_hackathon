/**
 * CommentaryOverlay - Lower-third style text captions for commentary.
 *
 * Displays the most recent commentary line with a fade-in animation,
 * styled like a sports broadcast lower third.
 */

interface CommentaryItem {
  id: number;
  text: string;
  emotion: string;
  timestamp: number;
}

interface CommentaryOverlayProps {
  items: CommentaryItem[];
}

const EMOTION_COLORS: Record<string, string> = {
  excited: "border-l-yellow-400",
  tense: "border-l-orange-500",
  thoughtful: "border-l-blue-400",
  celebratory: "border-l-green-400",
  disappointed: "border-l-red-400",
  urgent: "border-l-red-500",
  neutral: "border-l-gray-400",
};

export function CommentaryOverlay({ items }: CommentaryOverlayProps) {
  if (items.length === 0) return null;

  const latest = items[items.length - 1];
  const borderColor = EMOTION_COLORS[latest.emotion] || EMOTION_COLORS.neutral;

  return (
    <div className="pointer-events-none absolute bottom-16 left-4 right-4">
      <div
        key={latest.id}
        className={`animate-fade-in rounded border-l-4 ${borderColor} bg-black/75 px-4 py-3 backdrop-blur-sm`}
      >
        <p className="text-base font-medium leading-relaxed text-white drop-shadow-lg">
          {latest.text}
        </p>
      </div>

      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-fade-in {
          animation: fadeIn 0.3s ease-out;
        }
      `}</style>
    </div>
  );
}

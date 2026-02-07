/**
 * CommentaryOverlay - Displays current commentary text and active analyst.
 *
 * TODO: Implement after /plan p2-multi-analyst
 * - Show the current analyst name and avatar
 * - Display commentary text with fade-in/fade-out
 * - Show emotion indicator (excited, tense, etc.)
 */

interface CommentaryOverlayProps {
  analyst: string;
  text: string;
  emotion: string;
  visible: boolean;
}

export function CommentaryOverlay({
  analyst,
  text,
  emotion,
  visible,
}: CommentaryOverlayProps) {
  if (!visible) return null;

  return (
    <div className="commentary-overlay">
      <div className="analyst-badge">{analyst}</div>
      <div className="emotion-indicator">{emotion}</div>
      <p className="commentary-text">{text}</p>
    </div>
  );
}

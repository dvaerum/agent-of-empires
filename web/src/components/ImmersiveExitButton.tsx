/** Floating control to leave immersive mode, since the top bar (and its menu)
 *  is hidden while immersive. Fixed to the top-right, above everything, with a
 *  backdrop so it stays tappable over any content. Escape also exits (see
 *  useImmersive). */
export function ImmersiveExitButton({ onExit }: { onExit: () => void }) {
  return (
    <button
      onClick={onExit}
      className="fixed top-2 right-2 z-50 w-8 h-8 flex items-center justify-center rounded-md bg-surface-800/80 text-text-muted hover:text-text-primary hover:bg-surface-700 ring-1 ring-surface-700/50 backdrop-blur transition-colors safe-area-inset"
      title="Exit immersive mode (Esc)"
      aria-label="Exit immersive mode"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M9 9L4 4M9 9V5M9 9H5M15 9l5-5M15 9V5M15 9h4M9 15l-5 5M9 15v4M9 15H5M15 15l5 5M15 15v4M15 15h4" />
      </svg>
    </button>
  );
}

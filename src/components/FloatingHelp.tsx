import { HelpCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type FloatingHelpProps = {
  children: ReactNode;
  label: string;
  size?: number;
};

export function FloatingHelp({ children, label, size = 13 }: FloatingHelpProps) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  function openTooltip(element: HTMLElement) {
    setAnchor(element.getBoundingClientRect());
  }

  return (
    <>
      <button
        aria-label={label}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-graphite transition hover:bg-porcelain hover:text-ink focus:bg-porcelain focus:outline-none focus:ring-2 focus:ring-lavender/40"
        onBlur={() => setAnchor(null)}
        onFocus={(event) => openTooltip(event.currentTarget)}
        onMouseEnter={(event) => openTooltip(event.currentTarget)}
        onMouseLeave={() => setAnchor(null)}
        type="button"
      >
        <HelpCircle size={size} />
      </button>
      {anchor ? <FloatingTooltip anchor={anchor}>{children}</FloatingTooltip> : null}
    </>
  );
}

function FloatingTooltip({ anchor, children }: { anchor: DOMRect; children: ReactNode }) {
  const width = 288;
  const margin = 8;
  const left = Math.max(margin, Math.min(anchor.left + anchor.width / 2 - width / 2, window.innerWidth - width - margin));
  const arrowLeft = Math.max(14, Math.min(anchor.left + anchor.width / 2 - left - 6, width - 18));

  return createPortal(
    <div
      className="fixed z-[9999] w-72 rounded-xl border border-mist bg-white px-3 py-2 text-xs font-medium leading-5 text-ink shadow-panel"
      style={{
        left,
        top: anchor.bottom + 8,
      }}
    >
      <div
        className="absolute -top-1.5 h-3 w-3 rotate-45 border-l border-t border-mist bg-white"
        style={{ left: arrowLeft }}
      />
      {children}
    </div>,
    document.body,
  );
}

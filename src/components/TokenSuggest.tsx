import { useMemo, useRef, useState } from "react";
import type { TokenDefinition } from "../lib/tokens";

// Shared "$ token" autocomplete: typing `$` in a token-aware field opens a themed,
// scrollable list of the available tokens; typing after it filters ($year → Year);
// Enter/Tab/click inserts the {token}. Used by the contenteditable pattern fields
// and by TokenSuggestInput below for plain text inputs.

export function filterTokens(tokens: TokenDefinition[], query: string): TokenDefinition[] {
  const needle = query.toLowerCase();
  if (!needle) {
    return tokens;
  }
  const starts = tokens.filter(
    (token) => token.id.toLowerCase().startsWith(needle) || token.label.toLowerCase().startsWith(needle),
  );
  const contains = tokens.filter(
    (token) =>
      !starts.includes(token) &&
      (token.id.toLowerCase().includes(needle) || token.label.toLowerCase().includes(needle)),
  );
  return [...starts, ...contains];
}

export function TokenSuggestMenu({
  tokens,
  activeIndex,
  onPick,
  style,
}: {
  tokens: TokenDefinition[];
  activeIndex: number;
  onPick: (token: TokenDefinition) => void;
  style?: React.CSSProperties;
}) {
  if (tokens.length === 0) {
    return null;
  }
  return (
    <div
      className="absolute z-50 max-h-48 w-56 overflow-auto rounded-xl border border-mist bg-white py-1 shadow-panel"
      style={style}
    >
      {tokens.map((token, index) => (
        <button
          key={token.id}
          className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs transition ${
            index === activeIndex ? "bg-lavender/25 text-ink" : "text-graphite hover:bg-porcelain"
          }`}
          // Fire before the field's blur so picking works while it keeps focus.
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(token);
          }}
          type="button"
        >
          <span className="truncate font-semibold">{token.label}</span>
          <span className="shrink-0 font-mono text-[11px] text-graphite/60">{`{${token.id}}`}</span>
        </button>
      ))}
    </div>
  );
}

// Plain <input> with $-token autocomplete: the menu anchors under the input; picking
// replaces the `$query` just typed with `{token}` and keeps the caret after it.
export function TokenSuggestInput({
  ariaLabel,
  className,
  onChange,
  placeholder,
  tokens,
  value,
}: {
  ariaLabel?: string;
  className: string;
  onChange: (value: string) => void;
  placeholder?: string;
  tokens: TokenDefinition[];
  value: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const matches = useMemo(() => (query === null ? [] : filterTokens(tokens, query)), [query, tokens]);
  const open = query !== null && matches.length > 0;

  // Looks backwards from the caret for a `$query` trigger.
  function detect(next: string, caret: number) {
    const match = next.slice(0, caret).match(/\$([A-Za-z0-9_#]*)$/);
    setQuery(match ? match[1] : null);
    setActiveIndex(0);
  }

  function pick(token: (typeof tokens)[number]) {
    const el = inputRef.current;
    const caret = el?.selectionStart ?? value.length;
    const before = value.slice(0, caret).replace(/\$[A-Za-z0-9_#]*$/, "");
    const inserted = `${before}{${token.id}}`;
    const next = `${inserted}${value.slice(caret)}`;
    onChange(next);
    setQuery(null);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(inserted.length, inserted.length);
    });
  }

  return (
    <div className="relative min-w-0">
      <input
        ref={inputRef}
        aria-label={ariaLabel}
        className={className}
        onBlur={() => setQuery(null)}
        onChange={(event) => {
          onChange(event.target.value);
          detect(event.target.value, event.target.selectionStart ?? event.target.value.length);
        }}
        onKeyDown={(event) => {
          if (!open) {
            return;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((index) => (index + 1) % matches.length);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((index) => (index - 1 + matches.length) % matches.length);
          } else if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            pick(matches[activeIndex]);
          } else if (event.key === "Escape") {
            event.preventDefault();
            setQuery(null);
          }
        }}
        placeholder={placeholder}
        value={value}
      />
      {open ? (
        <TokenSuggestMenu
          activeIndex={activeIndex}
          onPick={pick}
          style={{ left: 0, top: "calc(100% + 4px)" }}
          tokens={matches}
        />
      ) : null}
    </div>
  );
}

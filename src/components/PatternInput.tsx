import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { previewPattern } from "../lib/tauri";
import { getTokenDefinitions, parsePattern } from "../lib/tokens";
import type { TokenDefinition, TokenScope } from "../lib/tokens";
import type { PresetVariable, TokenContext } from "../lib/types";

type PatternInputProps = {
  label: string;
  value: string;
  scope: TokenScope;
  variables: PresetVariable[];
  context: TokenContext;
  onChange: (value: string) => void;
  density?: "regular" | "compact";
  showTokenButtons?: boolean;
  showTokenPills?: boolean;
};

type SlashMenuState = {
  isOpen: boolean;
  query: string;
  start: number;
  highlightedIndex: number;
};

const closedSlashMenu: SlashMenuState = {
  isOpen: false,
  query: "",
  start: 0,
  highlightedIndex: 0,
};

export function PatternInput({
  label,
  value,
  scope,
  variables,
  context,
  onChange,
  density = "regular",
  showTokenButtons = true,
  showTokenPills = true,
}: PatternInputProps) {
  const [preview, setPreview] = useState("Resolving...");
  const [slashMenu, setSlashMenu] = useState<SlashMenuState>(closedSlashMenu);
  const inputRef = useRef<HTMLInputElement>(null);
  const tokens = useMemo(() => getTokenDefinitions(scope, variables), [scope, variables]);
  const parts = useMemo(() => parsePattern(value), [value]);
  const filteredTokens = useMemo(
    () => filterTokens(tokens, slashMenu.query),
    [slashMenu.query, tokens],
  );

  useEffect(() => {
    let isCurrent = true;
    previewPattern(value, context)
      .then((resolved) => {
        if (isCurrent) {
          setPreview(resolved);
        }
      })
      .catch((caught) => {
        if (isCurrent) {
          setPreview(String(caught));
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [value, context]);

  function insertToken(tokenId: string) {
    const input = inputRef.current;
    const tokenText = `{${tokenId}}`;
    if (!input) {
      onChange(`${value}${tokenText}`);
      return;
    }

    const start = input.selectionStart ?? value.length;
    const end = input.selectionEnd ?? value.length;
    const nextValue = `${value.slice(0, start)}${tokenText}${value.slice(end)}`;
    onChange(nextValue);
    closeSlashMenu();

    window.requestAnimationFrame(() => {
      input.focus();
      const nextCursor = start + tokenText.length;
      input.setSelectionRange(nextCursor, nextCursor);
    });
  }

  function insertAutocompleteToken(token: TokenDefinition) {
    const input = inputRef.current;
    const tokenText = `{${token.id}}`;
    const cursor = input?.selectionStart ?? value.length;
    const nextValue = `${value.slice(0, slashMenu.start)}${tokenText}${value.slice(cursor)}`;
    const nextCursor = slashMenu.start + tokenText.length;
    onChange(nextValue);
    closeSlashMenu();

    window.requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(nextCursor, nextCursor);
    });
  }

  function removePart(start: number, end: number) {
    const input = inputRef.current;
    const nextValue = `${value.slice(0, start)}${value.slice(end)}`;
    onChange(nextValue);
    closeSlashMenu();

    window.requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start, start);
    });
  }

  function updateSlashMenu(nextValue: string, cursor: number | null) {
    if (cursor === null) {
      closeSlashMenu();
      return;
    }

    const beforeCursor = nextValue.slice(0, cursor);
    const slashIndex = beforeCursor.lastIndexOf("/");
    if (slashIndex === -1) {
      closeSlashMenu();
      return;
    }

    const query = beforeCursor.slice(slashIndex + 1);
    const isValidQuery = /^[a-zA-Z0-9_# ]*$/.test(query);
    const isAtTokenBoundary = slashIndex === 0 || /[\s_-]/.test(beforeCursor[slashIndex - 1]);
    if (!isValidQuery || !isAtTokenBoundary) {
      closeSlashMenu();
      return;
    }

    setSlashMenu({ isOpen: true, query, start: slashIndex, highlightedIndex: 0 });
  }

  function closeSlashMenu() {
    setSlashMenu((current) => (current.isOpen ? closedSlashMenu : current));
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!slashMenu.isOpen) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeSlashMenu();
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSlashMenu((current) => ({
        ...current,
        highlightedIndex: (current.highlightedIndex + 1) % Math.max(filteredTokens.length, 1),
      }));
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSlashMenu((current) => ({
        ...current,
        highlightedIndex:
          (current.highlightedIndex - 1 + Math.max(filteredTokens.length, 1)) %
          Math.max(filteredTokens.length, 1),
      }));
      return;
    }

    if ((event.key === "Enter" || event.key === "Tab") && filteredTokens.length > 0) {
      event.preventDefault();
      insertAutocompleteToken(filteredTokens[slashMenu.highlightedIndex] ?? filteredTokens[0]);
    }
  }

  if (density === "compact") {
    return (
      <div className="relative">
        <input
          ref={inputRef}
          aria-label={label}
          className="h-8 w-full rounded-lg border border-mist bg-white px-2 text-xs font-medium outline-none transition focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
          onChange={(event) => {
            onChange(event.target.value);
            updateSlashMenu(event.target.value, event.target.selectionStart);
          }}
          onClick={(event) => updateSlashMenu(value, event.currentTarget.selectionStart)}
          onKeyDown={handleKeyDown}
          onKeyUp={(event) => {
            if (["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) {
              return;
            }
            updateSlashMenu(event.currentTarget.value, event.currentTarget.selectionStart);
          }}
          value={value}
        />

        <div className="mt-1 grid grid-cols-[44px_1fr] gap-1 text-[11px]">
          <span className="font-semibold text-graphite">Preview</span>
          <span className="min-w-0 truncate font-medium text-ink">{preview}</span>
        </div>

        {slashMenu.isOpen ? (
          <SlashMenu
            filteredTokens={filteredTokens}
            highlightedIndex={slashMenu.highlightedIndex}
            onInsert={insertAutocompleteToken}
          />
        ) : null}

        {showTokenButtons ? (
          <div className="mt-2 flex max-h-20 flex-wrap gap-1 overflow-auto rounded-lg bg-porcelain/70 p-1">
            {tokens.map((token) => (
              <button
                key={token.id}
                className="inline-flex h-6 items-center gap-1 rounded-md border border-mist bg-white px-1.5 text-[11px] font-semibold text-graphite transition hover:bg-porcelain hover:text-ink"
                onClick={() => insertToken(token.id)}
                type="button"
              >
                <Plus size={10} />
                {token.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="border-b border-mist p-3 last:border-b-0">
      <div className="mb-2 flex items-center justify-between gap-3">
        <label className="text-xs font-semibold text-graphite">{label}</label>
        <div className="truncate rounded-lg bg-porcelain px-2 py-1 text-xs font-medium text-ink ring-1 ring-mist">
          {preview}
        </div>
      </div>

      <input
        ref={inputRef}
        className="h-9 w-full rounded-xl border border-mist bg-white px-3 text-sm font-medium outline-none transition focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
        onChange={(event) => {
          onChange(event.target.value);
          updateSlashMenu(event.target.value, event.target.selectionStart);
        }}
        onClick={(event) => updateSlashMenu(value, event.currentTarget.selectionStart)}
        onKeyDown={handleKeyDown}
        onKeyUp={(event) => {
          if (["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) {
            return;
          }
          updateSlashMenu(event.currentTarget.value, event.currentTarget.selectionStart);
        }}
        value={value}
      />

      {slashMenu.isOpen ? (
        <SlashMenu
          filteredTokens={filteredTokens}
          highlightedIndex={slashMenu.highlightedIndex}
          onInsert={insertAutocompleteToken}
        />
      ) : null}

      {showTokenPills ? (
        <div className="mt-2 flex min-h-8 flex-wrap items-center gap-1.5 rounded-xl bg-porcelain p-1.5">
          {parts.map((part, index) =>
            part.type === "token" ? (
              <button
                key={`${part.value}-${index}`}
                className="inline-flex items-center gap-1 rounded-lg bg-white px-2 py-1 text-xs font-semibold text-ink ring-1 ring-mist transition hover:bg-red-50 hover:text-red-800 hover:ring-red-200"
                onClick={() => removePart(part.start, part.end)}
                title={`Remove ${part.value}`}
                type="button"
              >
                {part.value}
                <X size={11} />
              </button>
            ) : part.value ? (
              <span key={`${part.value}-${index}`} className="px-1 text-xs font-medium text-graphite">
                {part.value}
              </span>
            ) : null,
          )}
        </div>
      ) : null}

      {showTokenButtons ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {tokens.map((token) => (
            <button
              key={token.id}
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-mist bg-white px-2 text-xs font-semibold text-graphite transition hover:bg-porcelain hover:text-ink"
              onClick={() => insertToken(token.id)}
              type="button"
            >
              <Plus size={12} />
              {token.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SlashMenu({
  filteredTokens,
  highlightedIndex,
  onInsert,
}: {
  filteredTokens: TokenDefinition[];
  highlightedIndex: number;
  onInsert: (token: TokenDefinition) => void;
}) {
  return (
    <div className="mt-2 max-h-40 overflow-auto rounded-xl border border-mist bg-white p-1 shadow-panel">
      {filteredTokens.length === 0 ? (
        <div className="px-2 py-1.5 text-xs font-medium text-graphite">No matching tokens</div>
      ) : (
        filteredTokens.map((token, index) => (
          <button
            key={token.id}
            className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs transition ${
              index === highlightedIndex ? "bg-porcelain text-ink" : "text-graphite hover:bg-porcelain"
            }`}
            onMouseDown={(event) => {
              event.preventDefault();
              onInsert(token);
            }}
            type="button"
          >
            <span className="font-semibold">{token.label}</span>
            <code>{`{${token.id}}`}</code>
          </button>
        ))
      )}
    </div>
  );
}

function filterTokens(tokens: TokenDefinition[], query: string) {
  if (!query) {
    return tokens;
  }

  const normalizedQuery = query.toLowerCase();
  return tokens.filter(
    (token) =>
      token.id.toLowerCase().includes(normalizedQuery) ||
      token.label.toLowerCase().includes(normalizedQuery) ||
      token.scope.toLowerCase().includes(normalizedQuery),
  );
}

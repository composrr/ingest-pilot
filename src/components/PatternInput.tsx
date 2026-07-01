import { Plus } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { filterTokens, TokenSuggestMenu } from "./TokenSuggest";
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
  // Retained for API compatibility; tokens now render inline in the field.
  showTokenPills?: boolean;
};

type TokenFieldHandle = { insertToken: (tokenId: string) => void };

// Serialize the contenteditable field back to a pattern string: text nodes contribute
// their text; token pills contribute {token} from their data-token attribute.
function serializeField(el: HTMLElement): string {
  let output = "";
  el.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      output += node.textContent ?? "";
    } else if (node instanceof HTMLElement) {
      const token = node.dataset.token;
      output += token != null ? `{${token}}` : (node.textContent ?? "");
    }
  });
  return output;
}

function makePill(token: string): HTMLElement {
  const span = document.createElement("span");
  span.dataset.token = token;
  span.contentEditable = "false";
  span.className = "token-pill group text-ink";
  span.textContent = `{${token}}`;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.tabIndex = -1;
  remove.dataset.remove = "1";
  remove.className = "token-pill-x";
  remove.textContent = "×";
  span.appendChild(remove);
  return span;
}

function renderInto(el: HTMLElement, value: string) {
  el.textContent = "";
  for (const part of parsePattern(value)) {
    if (part.type === "text") {
      if (part.value) {
        el.appendChild(document.createTextNode(part.value));
      }
    } else {
      el.appendChild(makePill(part.value));
    }
  }
}

function clearSelectedPills(el: HTMLElement) {
  el.querySelectorAll(".token-pill.is-selected").forEach((pill) => pill.classList.remove("is-selected"));
}

// Where the caret sits inside a text node of the field, if it follows a `$query`
// token trigger. Returns the node/offset so the trigger text can be replaced.
function caretTokenTrigger(el: HTMLElement): { node: Text; offset: number; query: string } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE || !el.contains(node)) {
    return null;
  }
  const text = (node.textContent ?? "").slice(0, range.startOffset);
  const match = text.match(/\$([A-Za-z0-9_#]*)$/);
  if (!match) {
    return null;
  }
  return { node: node as Text, offset: range.startOffset, query: match[1] };
}

// A single-line, contenteditable pattern field where tokens are atomic pills: click a
// pill to select it and press Delete/Backspace to remove it, or use the X that appears
// on hover. Typing edits the literal text between tokens; typing `$` opens the token
// autocomplete at the caret ($year → Year, Enter inserts the pill).
const TokenPatternField = forwardRef<TokenFieldHandle, {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  dense?: boolean;
  tokens?: TokenDefinition[];
}>(function TokenPatternField({ value, onChange, ariaLabel, placeholder, dense, tokens = [] }, ref) {
  const fieldRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [suggest, setSuggest] = useState<{ query: string; left: number; top: number } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const matches = useMemo(() => (suggest ? filterTokens(tokens, suggest.query) : []), [suggest, tokens]);
  const menuOpen = suggest !== null && matches.length > 0;

  // Rebuild the DOM only when the value diverges from what's already shown, so typing
  // and pill edits keep their caret (our own edits set value === serialized DOM).
  useEffect(() => {
    const el = fieldRef.current;
    if (el && serializeField(el) !== value) {
      renderInto(el, value);
    }
  }, [value]);

  function emit() {
    const el = fieldRef.current;
    if (el) {
      onChange(serializeField(el));
    }
  }

  function insertTokenAtCaret(tokenId: string) {
    const el = fieldRef.current;
    if (!el) {
      return;
    }
    el.focus();
    const selection = window.getSelection();
    const pill = makePill(tokenId);
    if (selection && selection.rangeCount > 0 && el.contains(selection.anchorNode)) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(pill);
      range.setStartAfter(pill);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    } else {
      el.appendChild(pill);
    }
    emit();
  }

  // Refresh the $-trigger state from the caret; anchors the menu to the caret rect.
  function refreshSuggest() {
    const el = fieldRef.current;
    const wrapper = wrapperRef.current;
    if (!el || !wrapper) {
      return;
    }
    const trigger = caretTokenTrigger(el);
    if (!trigger) {
      setSuggest(null);
      return;
    }
    const selection = window.getSelection();
    const caretRect = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).getBoundingClientRect() : null;
    const wrapperRect = wrapper.getBoundingClientRect();
    setSuggest({
      query: trigger.query,
      left: caretRect ? Math.max(0, caretRect.left - wrapperRect.left) : 0,
      top: caretRect ? caretRect.bottom - wrapperRect.top + 4 : wrapperRect.height + 4,
    });
    setActiveIndex(0);
  }

  // Replace the typed `$query` with the chosen token pill.
  function pickToken(tokenId: string) {
    const el = fieldRef.current;
    if (!el) {
      return;
    }
    const trigger = caretTokenTrigger(el);
    if (trigger) {
      const range = document.createRange();
      range.setStart(trigger.node, trigger.offset - trigger.query.length - 1);
      range.setEnd(trigger.node, trigger.offset);
      range.deleteContents();
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    setSuggest(null);
    insertTokenAtCaret(tokenId);
  }

  useImperativeHandle(ref, () => ({
    insertToken(tokenId: string) {
      insertTokenAtCaret(tokenId);
    },
  }));

  return (
    <div className="relative min-w-0" ref={wrapperRef}>
      <div
        ref={fieldRef}
        aria-label={ariaLabel}
        className={`token-field w-full overflow-x-auto whitespace-nowrap rounded-xl border border-mist bg-white outline-none transition focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30 ${
          dense ? "min-h-8 px-2 py-1 text-xs" : "min-h-9 px-3 py-1.5 text-sm"
        } font-medium`}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder ?? ""}
        onBlur={() => {
          clearSelectedPills(fieldRef.current!);
          setSuggest(null);
        }}
        onClick={(event) => {
          const el = fieldRef.current;
          if (!el) {
            return;
          }
          const pill = (event.target as HTMLElement).closest<HTMLElement>(".token-pill");
          clearSelectedPills(el);
          if (pill && !(event.target as HTMLElement).dataset.remove) {
            pill.classList.add("is-selected");
            const range = document.createRange();
            range.selectNode(pill);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
          }
        }}
        onInput={() => {
          emit();
          refreshSuggest();
        }}
        onKeyDown={(event) => {
          if (menuOpen) {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveIndex((index) => (index + 1) % matches.length);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((index) => (index - 1 + matches.length) % matches.length);
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              pickToken(matches[activeIndex].id);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setSuggest(null);
              return;
            }
          }
          if (event.key === "Enter") {
            event.preventDefault();
          }
        }}
        onMouseDown={(event) => {
          const target = event.target as HTMLElement;
          if (target.dataset.remove) {
            // Delete the whole pill without disturbing focus/caret.
            event.preventDefault();
            target.closest(".token-pill")?.remove();
            emit();
          }
        }}
        onPaste={(event) => {
          event.preventDefault();
          const text = event.clipboardData.getData("text/plain").replace(/\r?\n/g, " ");
          // execCommand is deprecated but still the simplest caret-preserving insert.
          document.execCommand("insertText", false, text);
        }}
      />
      {menuOpen ? (
        <TokenSuggestMenu
          activeIndex={activeIndex}
          onPick={(token) => pickToken(token.id)}
          style={{ left: Math.min(suggest.left, 200), top: suggest.top }}
          tokens={matches}
        />
      ) : null}
    </div>
  );
});

export function PatternInput({
  label,
  value,
  scope,
  variables,
  context,
  onChange,
  density = "regular",
  showTokenButtons = true,
}: PatternInputProps) {
  const [preview, setPreview] = useState("Resolving...");
  const fieldRef = useRef<TokenFieldHandle>(null);
  const tokens = getTokenDefinitions(scope, variables);

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

  const tokenButtons = showTokenButtons ? (
    <div className={`mt-2 flex flex-wrap gap-1 ${density === "compact" ? "max-h-20 overflow-auto rounded-lg bg-porcelain/70 p-1" : ""}`}>
      {tokens.map((token) => (
        <button
          key={token.id}
          className={`inline-flex items-center gap-1 rounded-lg border border-mist bg-white font-semibold text-graphite transition hover:bg-porcelain hover:text-ink ${
            density === "compact" ? "h-6 px-1.5 text-[11px]" : "h-7 px-2 text-xs"
          }`}
          onClick={() => fieldRef.current?.insertToken(token.id)}
          type="button"
        >
          <Plus size={density === "compact" ? 10 : 12} />
          {token.label}
        </button>
      ))}
    </div>
  ) : null;

  if (density === "compact") {
    return (
      <div>
        <TokenPatternField ariaLabel={label} dense onChange={onChange} placeholder="Pattern ($ for tokens)" ref={fieldRef} tokens={tokens} value={value} />
        <div className="mt-1 grid grid-cols-[44px_1fr] gap-1 text-[11px]">
          <span className="font-semibold text-graphite">Preview</span>
          <span className="min-w-0 truncate font-medium text-ink">{preview}</span>
        </div>
        {tokenButtons}
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
      <TokenPatternField ariaLabel={label} onChange={onChange} placeholder="Type text — $ for tokens…" ref={fieldRef} tokens={tokens} value={value} />
      {tokenButtons}
    </div>
  );
}

import { Plus } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { previewPattern } from "../lib/tauri";
import { getTokenDefinitions, parsePattern } from "../lib/tokens";
import type { TokenScope } from "../lib/tokens";
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

// A single-line, contenteditable pattern field where tokens are atomic pills: click a
// pill to select it and press Delete/Backspace to remove it, or use the X that appears
// on hover. Typing edits the literal text between tokens.
const TokenPatternField = forwardRef<TokenFieldHandle, {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  dense?: boolean;
}>(function TokenPatternField({ value, onChange, ariaLabel, placeholder, dense }, ref) {
  const fieldRef = useRef<HTMLDivElement>(null);

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

  useImperativeHandle(ref, () => ({
    insertToken(tokenId: string) {
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
    },
  }));

  return (
    <div
      ref={fieldRef}
      aria-label={ariaLabel}
      className={`token-field w-full overflow-x-auto whitespace-nowrap rounded-xl border border-mist bg-white outline-none transition focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30 ${
        dense ? "min-h-8 px-2 py-1 text-xs" : "min-h-9 px-3 py-1.5 text-sm"
      } font-medium`}
      contentEditable
      suppressContentEditableWarning
      data-placeholder={placeholder ?? ""}
      onBlur={() => clearSelectedPills(fieldRef.current!)}
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
      onInput={emit}
      onKeyDown={(event) => {
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
        <TokenPatternField ariaLabel={label} dense onChange={onChange} placeholder="Pattern" ref={fieldRef} value={value} />
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
      <TokenPatternField ariaLabel={label} onChange={onChange} placeholder="Type text and insert tokens…" ref={fieldRef} value={value} />
      {tokenButtons}
    </div>
  );
}

import { ChevronDown, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type SelectMenuOption = {
  label: string;
  value: string;
};

type SelectMenuProps = {
  disabled?: boolean;
  onChange: (value: string) => void;
  options: SelectMenuOption[];
  placeholder?: string;
  size?: "sm" | "md";
  /** Show a type-to-filter box. Defaults on automatically once the list is long. */
  searchable?: boolean;
  /** Alphabetize the options by label (a leading empty-value placeholder stays on top). */
  sortOptions?: boolean;
  value: string;
};

// Lists at or above this length get a search box even without an explicit prop,
// so long dropdowns throughout the app are filterable.
const SEARCH_AUTO_THRESHOLD = 8;

export function SelectMenu({
  disabled = false,
  onChange,
  options,
  placeholder = "Choose...",
  size = "md",
  searchable,
  sortOptions = false,
  value,
}: SelectMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [menuStyle, setMenuStyle] = useState<MenuStyle | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selected = useMemo(() => options.find((option) => option.value === value), [options, value]);
  const buttonClass =
    size === "sm"
      ? "h-8 rounded-lg px-2 text-xs"
      : "h-9 rounded-xl px-3 text-sm";

  // Sort alphabetically when asked, always pinning an empty-value placeholder first.
  const orderedOptions = useMemo(() => {
    if (!sortOptions) {
      return options;
    }
    return [...options].sort((a, b) => {
      if (a.value === "") return -1;
      if (b.value === "") return 1;
      return a.label.localeCompare(b.label);
    });
  }, [options, sortOptions]);

  const showSearch = searchable ?? options.length >= SEARCH_AUTO_THRESHOLD;
  const filteredOptions = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
      return orderedOptions;
    }
    // Keep an empty-value placeholder visible so the "clear"/default choice stays reachable.
    return orderedOptions.filter(
      (option) => option.value === "" || option.label.toLowerCase().includes(trimmed),
    );
  }, [orderedOptions, query]);

  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      return;
    }

    updateMenuPosition();
    if (showSearch) {
      // Focus the filter box so the user can just start typing.
      window.requestAnimationFrame(() => searchRef.current?.focus());
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (!containerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setIsOpen(false);
      }
    }

    function handleLayoutChange() {
      updateMenuPosition();
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("resize", handleLayoutChange);
    window.addEventListener("scroll", handleLayoutChange, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", handleLayoutChange);
      window.removeEventListener("scroll", handleLayoutChange, true);
    };
  }, [isOpen]);

  function updateMenuPosition() {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    const width = Math.max(rect.width, 208);
    const gap = 4;
    const maxHeight = Math.min(256, window.innerHeight - 16);
    const opensUp = rect.bottom + gap + maxHeight > window.innerHeight && rect.top > window.innerHeight - rect.bottom;
    const top = opensUp ? Math.max(8, rect.top - gap - maxHeight) : Math.min(window.innerHeight - 8, rect.bottom + gap);
    const left = Math.min(Math.max(8, rect.right - width), Math.max(8, window.innerWidth - width - 8));

    setMenuStyle({
      left,
      maxHeight,
      top,
      width,
    });
  }

  function choose(nextValue: string) {
    onChange(nextValue);
    setIsOpen(false);
  }

  return (
    <div ref={containerRef} className="relative min-w-0">
      <button
        className={`flex w-full min-w-0 items-center gap-2 border border-mist bg-white text-left outline-none transition hover:bg-porcelain focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30 disabled:cursor-not-allowed disabled:opacity-50 ${buttonClass}`}
        disabled={disabled}
        onClick={() => setIsOpen((current) => !current)}
        type="button"
      >
        <span className={`min-w-0 flex-1 truncate ${selected ? "font-semibold text-ink" : "text-graphite"}`}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown className="shrink-0 text-graphite" size={15} />
      </button>

      {isOpen && menuStyle ? createPortal(
        <div
          ref={menuRef}
          className="fixed z-[10000] overflow-hidden rounded-xl border border-mist bg-white p-1 shadow-panel"
          style={{
            left: menuStyle.left,
            top: menuStyle.top,
            width: menuStyle.width,
          }}
        >
          {showSearch ? (
            <div className="mb-1 flex items-center gap-1.5 rounded-lg border border-mist bg-porcelain/60 px-2">
              <Search className="shrink-0 text-graphite" size={13} />
              <input
                ref={searchRef}
                className="h-7 w-full min-w-0 bg-transparent text-xs outline-none placeholder:text-graphite/70"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setIsOpen(false);
                  } else if (event.key === "Enter") {
                    // Enter selects the first match so search-then-Enter picks it.
                    const first = filteredOptions.find((option) => option.value !== "");
                    if (first) {
                      event.preventDefault();
                      choose(first.value);
                    }
                  }
                }}
                placeholder="Search…"
                value={query}
              />
            </div>
          ) : null}
          <div className="overflow-auto" style={{ maxHeight: menuStyle.maxHeight }}>
              {options.length === 0 ? (
                <div className="px-2 py-2 text-sm font-medium text-graphite">{placeholder}</div>
              ) : filteredOptions.length === 0 ? (
                <div className="px-2 py-2 text-xs font-medium text-graphite">No matches</div>
              ) : (
                filteredOptions.map((option) => {
                  const selectedOption = option.value === value;
                  return (
                    <button
                      key={option.value}
                      className={`flex h-8 w-full items-center rounded-lg px-2 text-left text-sm transition ${
                        selectedOption ? "bg-lavender/25 text-ink" : "text-graphite hover:bg-porcelain"
                      }`}
                      onClick={() => choose(option.value)}
                      type="button"
                    >
                      <span className="min-w-0 flex-1 truncate font-semibold">{option.label}</span>
                    </button>
                  );
                })
              )}
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

type MenuStyle = {
  left: number;
  maxHeight: number;
  top: number;
  width: number;
};

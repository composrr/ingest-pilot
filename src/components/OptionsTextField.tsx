import { useEffect, useState } from "react";
import { optionsFromText } from "../lib/parameters";

type OptionsTextFieldProps = {
  onChange: (options: string[]) => void;
  placeholder: string;
  value: string[];
};

export function OptionsTextField({ onChange, placeholder, value }: OptionsTextFieldProps) {
  const [draft, setDraft] = useState(() => value.join(", "));

  useEffect(() => {
    const normalizedDraft = optionsFromText(draft).join(", ");
    const normalizedValue = value.join(", ");
    if (normalizedDraft !== normalizedValue) {
      setDraft(normalizedValue);
    }
  }, [draft, value]);

  return (
    <input
      className="h-8 min-w-0 rounded-lg border border-mist bg-white px-2 text-xs outline-none focus:border-graphite/40 focus:ring-2 focus:ring-lavender/30"
      onBlur={() => setDraft(optionsFromText(draft).join(", "))}
      onChange={(event) => {
        setDraft(event.target.value);
        onChange(optionsFromText(event.target.value));
      }}
      placeholder={placeholder}
      value={draft}
    />
  );
}

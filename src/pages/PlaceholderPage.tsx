import { ArrowLeft } from "lucide-react";
import { useAppStore } from "../stores/appStore";

type PlaceholderPageProps = {
  eyebrow: string;
  title: string;
  body: string;
  cards: Array<{ title: string; body: string }>;
  onBack: () => void;
};

export function PlaceholderPage({ eyebrow, title, body, cards, onBack }: PlaceholderPageProps) {
  const lastAction = useAppStore((state) => state.lastAction);

  return (
    <div className="flex min-h-full w-full flex-col rounded-[28px] border border-mist bg-paper p-2 shadow-panel xl:p-3">
      <header className="mb-2 flex items-start justify-between gap-3">
        <div>
          <p className="mb-0.5 text-[11px] font-semibold text-graphite/70">{eyebrow}</p>
          <h1 className="text-xl font-semibold tracking-normal">{title}</h1>
          <p className="mt-1 max-w-2xl text-sm leading-5 text-graphite">{body}</p>
        </div>
        <button
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-signal px-2.5 text-xs font-semibold text-paper transition hover:bg-black"
          onClick={onBack}
          type="button"
        >
          <ArrowLeft size={16} />
          Home
        </button>
      </header>

      <section className="grid gap-2 md:grid-cols-3">
        {cards.map((card) => (
          <article key={card.title} className="rounded-2xl border border-mist bg-white p-3">
            <h2 className="mb-1 text-sm font-semibold">{card.title}</h2>
            <p className="text-sm leading-5 text-graphite">{card.body}</p>
          </article>
        ))}
      </section>

      <footer className="mt-auto pt-3 text-xs text-graphite/70">Last action: {lastAction}</footer>
    </div>
  );
}

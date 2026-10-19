export function PageHeader({ title, lede, actions }: { title: string; lede?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-line pb-4">
      <div className="max-w-[70ch]">
        <h1 className="text-[26px] leading-tight font-bold tracking-[-0.01em]">{title}</h1>
        {lede ? <p className="mt-1.5 text-[15px] leading-relaxed text-ink-2">{lede}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

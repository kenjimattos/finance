export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rule-top rule-bottom py-6">
      <div className="eyebrow mb-2 text-[color:var(--color-accent)]">erro</div>
      <p className="font-display text-xl text-[color:var(--color-ink)]">{message}</p>
    </div>
  );
}

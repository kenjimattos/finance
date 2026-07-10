import { useState } from 'react';
import { formatBRL, variationLabel } from '../lib/format';

/**
 * The "Divisão" section: partner-owes headline + three columns (½, dela,
 * meu), each with a category breakdown and an installment list.
 *
 * Presentational only — it does not fetch. The Dashboard passes a single
 * account's split summary; the Overview passes a figure aggregated across
 * every account. Both normalize to {@link SplitSectionData}.
 *
 * `variant` controls scale and chrome:
 *  - `card`    — embedded in the account Dashboard, smaller, dot eyebrow.
 *  - `section` — top-level on the Overview, larger, `.eyebrow` heading.
 */
export interface SplitSectionData {
  partnerOwes: number;
  totalCount: number;
  breakdown: {
    half: { count: number; total: number; owes: number };
    theirs: { count: number; total: number; owes: number };
    mine: { count: number; total: number };
  };
  categories: Array<{
    id: number;
    name: string;
    color: string;
    halfTotal: number;
    theirsTotal: number;
    mineTotal: number;
    prevHalfTotal: number;
    prevTheirsTotal: number;
    prevMineTotal: number;
  }>;
  installments: Array<{
    id: string;
    description: string | null;
    amount: number;
    splitType: 'half' | 'theirs' | 'mine';
    installmentNumber: number;
    totalInstallments: number;
  }>;
}

type Variant = 'card' | 'section';

const VARIANTS: Record<
  Variant,
  {
    wrapperClass: string;
    headlineClass: string;
    columnTotalClass: string;
    columnChildGap: string;
    gridMargin: string;
    gridGap: string;
    catLimit: number;
  }
> = {
  card: {
    wrapperClass: 'rule-top mt-10 pt-6 text-left',
    headlineClass:
      'font-display text-[44px] leading-none tracking-[-0.02em] text-[color:var(--color-ink)]',
    columnTotalClass: 'mt-1 font-display text-[28px] leading-none tracking-[-0.02em]',
    columnChildGap: 'mt-4',
    gridMargin: 'mt-6',
    gridGap: 'gap-6',
    catLimit: 4,
  },
  section: {
    wrapperClass: 'mt-14',
    headlineClass:
      'font-display text-[48px] leading-none tracking-[-0.025em] text-[color:var(--color-ink)] md:text-[56px]',
    columnTotalClass: 'mt-1 font-display text-[32px] leading-none tracking-[-0.02em]',
    columnChildGap: 'mt-5',
    gridMargin: 'mt-8',
    gridGap: 'gap-4',
    catLimit: 6,
  },
};

const INST_LIMIT = 4;

type CategoryItem = { id: number; name: string; color: string; total: number; prev: number };
type InstallmentItem = SplitSectionData['installments'][number];

export function SplitSection({
  split,
  variant,
}: {
  split: SplitSectionData;
  variant: Variant;
}) {
  const v = VARIANTS[variant];

  // Headline figures: each person's share of the divided spend. "dela" is
  // partnerOwes (theirs + half of the ½ pot); "meu" mirrors it with my own
  // rows plus the remaining half. Derived from owes (not total/2) so the two
  // figures always sum to the categorized total despite rounding.
  const myShare =
    split.breakdown.mine.total + (split.breakdown.half.total - split.breakdown.half.owes);
  // per-category and per-installment figures.
  const makeCatList = (
    key: 'halfTotal' | 'theirsTotal' | 'mineTotal',
    prevKey: 'prevHalfTotal' | 'prevTheirsTotal' | 'prevMineTotal',
  ): CategoryItem[] =>
    split.categories
      .filter((c) => c[key] > 0)
      .map((c) => ({ id: c.id, name: c.name, color: c.color, total: c[key], prev: c[prevKey] }))
      .sort((a, b) => b.total - a.total);
  const halfCategories = makeCatList('halfTotal', 'prevHalfTotal');
  const theirsCategories = makeCatList('theirsTotal', 'prevTheirsTotal');
  const mineCategories = makeCatList('mineTotal', 'prevMineTotal');

  const halfInstallments = split.installments.filter((i) => i.splitType === 'half');
  const theirsInstallments = split.installments.filter((i) => i.splitType === 'theirs');
  const mineInstallments = split.installments.filter((i) => i.splitType === 'mine');

  const columns: React.ReactNode[] = [];
  if (split.breakdown.half.count > 0) {
    columns.push(
      <SplitColumn
        key="half"
        variant={variant}
        label="½"
        total={formatBRL(split.breakdown.half.owes)}
        subtitle={`${split.breakdown.half.count}x — total ${formatBRL(split.breakdown.half.total)}`}
        categories={halfCategories}
        installments={halfInstallments}
      />,
    );
  }
  if (split.breakdown.theirs.count > 0) {
    columns.push(
      <SplitColumn
        key="theirs"
        variant={variant}
        label="dela"
        total={formatBRL(split.breakdown.theirs.owes)}
        subtitle={`${split.breakdown.theirs.count}x — total ${formatBRL(split.breakdown.theirs.total)}`}
        categories={theirsCategories}
        installments={theirsInstallments}
        accent
      />,
    );
  }
  if (split.breakdown.mine.count > 0) {
    columns.push(
      <SplitColumn
        key="mine"
        variant={variant}
        label="meu"
        total={formatBRL(split.breakdown.mine.total)}
        subtitle={`${split.breakdown.mine.count}x`}
        categories={mineCategories}
        installments={mineInstallments}
      />,
    );
  }
  const cols =
    columns.length === 1
      ? 'md:grid-cols-1'
      : columns.length === 2
        ? 'md:grid-cols-2'
        : 'md:grid-cols-3';

  return (
    <section className={v.wrapperClass}>
      {variant === 'card' ? (
        <div className="mb-3 flex items-center gap-2">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: 'var(--color-accent)' }}
            aria-hidden="true"
          />
          <span className="font-body text-[11px] uppercase tracking-[0.14em] text-[color:var(--color-accent)]">
            Divisão
          </span>
          <span className="font-mono text-[10px] text-[color:var(--color-ink-faint)]">
            ({split.totalCount})
          </span>
        </div>
      ) : (
        <div className="eyebrow mb-6 uppercase">divisão</div>
      )}

      <div className="flex flex-wrap items-baseline gap-x-10 gap-y-4">
        <div>
          <div className="font-body text-[10px] uppercase tracking-[0.14em] text-[color:var(--color-ink-faint)]">
            meu
          </div>
          <div className={v.headlineClass}>{formatBRL(myShare)}</div>
        </div>
        <div>
          <div className="font-body text-[10px] uppercase tracking-[0.14em] text-[color:var(--color-ink-faint)]">
            dela
          </div>
          <div className={v.headlineClass} style={{ color: 'var(--color-accent)' }}>
            {formatBRL(split.partnerOwes)}
          </div>
        </div>
      </div>

      {variant === 'section' && (
        <p className="mt-2 font-body text-sm text-[color:var(--color-ink-muted)]">
          {split.totalCount}{' '}
          {split.totalCount === 1 ? 'transação dividida' : 'transações divididas'}
        </p>
      )}

      <div className={`md:m-${v.gridMargin} flex-col md:grid ${cols} ${v.gridGap}`}>{columns}</div>
    </section>
  );
}

function SplitColumn({
  variant,
  label,
  total,
  subtitle,
  categories,
  installments,
  accent,
}: {
  variant: Variant;
  label: string;
  total: string;
  subtitle: string;
  categories: CategoryItem[];
  installments: InstallmentItem[];
  accent?: boolean;
}) {
  const v = VARIANTS[variant];
  return (
    <div className='p-10 border border-[color:var(--color-paper-rule)] mt-5'>
      <div className="font-body text-[10px] uppercase tracking-[0.14em] text-[color:var(--color-ink-faint)]">
        {label}
      </div>
      <div
        className={v.columnTotalClass}
        style={{ color: accent ? 'var(--color-accent)' : 'var(--color-ink)' }}
      >
        {total}
      </div>
      <div className="mt-1 font-body text-[10px] text-[color:var(--color-ink-faint)]">
        {subtitle}
      </div>
      {categories.length > 0 && (
        <div className={v.columnChildGap}>
          <CategoryList categories={categories} limit={v.catLimit} accent={accent} />
        </div>
      )}
      {installments.length > 0 && (
        <div
          className={`${v.columnChildGap} border-t border-[color:var(--color-paper-rule)] pt-3`}
        >
          <InstallmentList installments={installments} accent={accent} />
        </div>
      )}
    </div>
  );
}

function CategoryList({
  categories,
  limit,
  accent,
}: {
  categories: CategoryItem[];
  limit: number;
  accent?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? categories : categories.slice(0, limit);
  const hiddenCount = categories.length - limit;
  const denominator = categories.reduce((acc, c) => acc + Math.max(0, c.total), 0) || 1;

  return (
    <div>
      <ul className="space-y-2.5">
        {visible.map((cat) => (
          <li key={cat.id}>
            <div className="flex items-baseline justify-between gap-4 font-body text-[12px]">
              <span className="truncate text-[color:var(--color-ink-soft)]">{cat.name}</span>
              <span className="flex shrink-0 items-baseline gap-1.5">
                <span
                  className="font-mono tabular-nums"
                  style={{ color: accent ? 'var(--color-accent)' : 'var(--color-ink-muted)' }}
                >
                  {formatBRL(cat.total)}
                </span>
                {variationLabel(cat.total, cat.prev) && (
                  <span className="font-mono text-[10px] tabular-nums text-[color:var(--color-ink-faint)]">
                    ({variationLabel(cat.total, cat.prev)})
                  </span>
                )}
              </span>
            </div>
            <div className="mt-1 h-[2px] w-full bg-[color:var(--color-paper-rule)]">
              <div
                className="h-full"
                style={{
                  background: cat.color,
                  width: `${Math.round((Math.max(0, cat.total) / denominator) * 100)}%`,
                }}
              />
            </div>
          </li>
        ))}
      </ul>
      {hiddenCount > 0 && (
        <ExpandToggle
          expanded={expanded}
          hiddenCount={hiddenCount}
          onToggle={() => setExpanded((e) => !e)}
        />
      )}
    </div>
  );
}

function InstallmentList({
  installments,
  accent,
}: {
  installments: InstallmentItem[];
  accent?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? installments : installments.slice(0, INST_LIMIT);
  const hiddenCount = installments.length - INST_LIMIT;
  const total = installments.reduce((acc, i) => acc + i.amount, 0);

  return (
    <div>
      <div className="mb-2.5 flex items-baseline justify-between gap-2">
        <span className="font-body text-[10px] uppercase tracking-[0.12em] text-[color:var(--color-ink-faint)]">
          parcelas · {installments.length}
        </span>
        <span
          className="font-mono text-[12px] tabular-nums"
          style={{ color: accent ? 'var(--color-accent)' : 'var(--color-ink-muted)' }}
        >
          {formatBRL(total)}
        </span>
      </div>
      <ul className="space-y-2">
        {visible.map((inst) => (
          <li
            key={inst.id}
            className="grid grid-cols-[1fr_auto_auto] items-baseline gap-3 font-body text-[12px]"
          >
            <span className="truncate text-[color:var(--color-ink-soft)]">
              {stripInstallmentSuffix(inst.description)}
            </span>
            <span className="font-mono text-[10px] tabular-nums text-[color:var(--color-ink-faint)]">
              {inst.installmentNumber}/{inst.totalInstallments}
            </span>
            <span
              className="font-mono tabular-nums"
              style={{ color: accent ? 'var(--color-accent)' : 'var(--color-ink-muted)' }}
            >
              {formatBRL(inst.amount)}
            </span>
          </li>
        ))}
      </ul>
      {hiddenCount > 0 && (
        <ExpandToggle
          expanded={expanded}
          hiddenCount={hiddenCount}
          onToggle={() => setExpanded((e) => !e)}
        />
      )}
    </div>
  );
}

function ExpandToggle({
  expanded,
  hiddenCount,
  onToggle,
}: {
  expanded: boolean;
  hiddenCount: number;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="mt-3 font-body text-[11px] uppercase tracking-[0.1em] text-[color:var(--color-ink-muted)] transition-colors hover:text-[color:var(--color-accent)]"
    >
      {expanded ? '− recolher' : `+ ${hiddenCount} mais`}
    </button>
  );
}

const INSTALLMENT_SUFFIX = /\s*PARC\d{1,2}\/\d{1,2}\s*$/i;

function stripInstallmentSuffix(description: string | null): string {
  if (!description) return '—';
  return description.replace(INSTALLMENT_SUFFIX, '').trim() || '—';
}

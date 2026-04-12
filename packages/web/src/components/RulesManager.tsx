import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { api, type Category, type Rule } from '../lib/api';
import { useToast } from './Toast';

/**
 * Full-screen overlay for viewing, editing, and deleting learned
 * categorization rules. Same portal + overlay pattern as CardGroupsManager.
 *
 * Layout:
 *  - Search input at top (debounced, filters by merchant_slug)
 *  - Table of rules: slug (mono), category dot + name, hit count, actions
 *  - Edit: inline dropdown to reassign category
 *  - Delete: click → immediate removal with undo toast
 */
export function RulesManager({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rulesQ = useQuery({
    queryKey: ['rules', debouncedSearch],
    queryFn: () => api.listRules(debouncedSearch || undefined),
  });

  const categoriesQ = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.listCategories(),
  });

  const rules = rulesQ.data ?? [];
  const categories = categoriesQ.data ?? [];

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[900] flex items-start justify-center overflow-y-auto bg-[color:var(--color-ink)]/40 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ y: 24, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.25, ease: [0.2, 0.65, 0.3, 0.9] }}
        className="relative my-12 w-full max-w-[720px] border border-[color:var(--color-ink)] bg-[color:var(--color-paper)] p-8 shadow-[8px_8px_0_0_var(--color-ink)]"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Fechar"
          className="absolute right-4 top-4 font-mono text-lg text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-accent)]"
        >
          ✕
        </button>

        <div className="eyebrow mb-2">Categorização</div>
        <h2 className="font-display text-4xl leading-tight tracking-tight text-[color:var(--color-ink)]">
          Regras aprendidas
        </h2>
        <p className="mt-3 max-w-[52ch] font-body text-sm text-[color:var(--color-ink-muted)]">
          Cada vez que você categoriza uma transação, o sistema aprende uma
          regra baseada no nome do estabelecimento. Aqui você pode ver, editar
          ou excluir essas regras.
        </p>

        <div className="mt-6">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por estabelecimento..."
            className="w-full border-b border-[color:var(--color-paper-rule)] bg-transparent py-2 font-mono text-sm text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-faint)] focus:border-[color:var(--color-accent)] focus:outline-none"
          />
        </div>

        <div className="mt-6 max-h-[60vh] overflow-y-auto">
          {rules.length === 0 && !rulesQ.isLoading && (
            <p className="py-8 text-center font-body text-sm italic text-[color:var(--color-ink-faint)]">
              {debouncedSearch
                ? 'Nenhuma regra encontrada.'
                : 'Nenhuma regra aprendida ainda.'}
            </p>
          )}
          <div className="divide-y divide-[color:var(--color-paper-rule)]">
            {rules.map((rule) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                categories={categories}
                onDeleted={() => {
                  queryClient.invalidateQueries({ queryKey: ['rules'] });
                }}
                onUpdated={() => {
                  queryClient.invalidateQueries({ queryKey: ['rules'] });
                }}
                toast={toast}
              />
            ))}
          </div>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}

function RuleRow({
  rule,
  categories,
  onDeleted,
  onUpdated,
  toast,
}: {
  rule: Rule;
  categories: Category[];
  onDeleted: () => void;
  onUpdated: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const deleteMut = useMutation({
    mutationFn: () => api.deleteRule(rule.id),
    onSuccess: () => {
      onDeleted();
      toast.show({ message: `Regra "${rule.merchant_slug}" excluída` });
    },
  });

  const updateMut = useMutation({
    mutationFn: (categoryId: number) => api.updateRule(rule.id, categoryId),
    onSuccess: () => {
      onUpdated();
      toast.show({ message: `Regra "${rule.merchant_slug}" atualizada` });
    },
  });

  // Group categories: current first, then the rest sorted alphabetically
  const sortedCategories = useMemo(() => {
    const current = categories.find((c) => c.id === rule.user_category_id);
    const rest = categories
      .filter((c) => c.id !== rule.user_category_id)
      .sort((a, b) => a.name.localeCompare(b.name));
    return current ? [current, ...rest] : rest;
  }, [categories, rule.user_category_id]);

  return (
    <div className="flex items-center gap-4 py-3">
      {/* Slug */}
      <div className="min-w-0 flex-1">
        <span className="font-mono text-sm text-[color:var(--color-ink)]">
          {rule.merchant_slug}
        </span>
        <span className="ml-3 font-mono text-[10px] text-[color:var(--color-ink-faint)]">
          {rule.hit_count}x
        </span>
      </div>

      {/* Category selector */}
      <div className="flex items-center gap-2">
        <span
          className="h-2 w-2 rounded-full"
          style={{ background: rule.user_category_color }}
          aria-hidden="true"
        />
        <select
          value={rule.user_category_id}
          onChange={(e) => {
            const newId = Number(e.target.value);
            if (newId !== rule.user_category_id) {
              updateMut.mutate(newId);
            }
          }}
          className="border-none bg-transparent font-body text-sm text-[color:var(--color-ink)] focus:outline-none"
        >
          {sortedCategories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {/* Delete */}
      <button
        type="button"
        onClick={() => deleteMut.mutate()}
        disabled={deleteMut.isPending}
        className="font-mono text-xs text-[color:var(--color-ink-faint)] transition-colors hover:text-[color:var(--color-accent)] disabled:opacity-40"
        aria-label={`Excluir regra ${rule.merchant_slug}`}
      >
        ✕
      </button>
    </div>
  );
}

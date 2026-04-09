# Roadmap

Ideas and planned features, roughly grouped by theme. Nothing here is committed — this is a thinking space for prioritization. When something moves to implementation, it gets a PR and leaves this list.

## Fatura por banco (arquitetura decidida, não implementada)

Hoje existe um único `card_settings` por `itemId` com um par `closing_day`/`due_day`. Quando o usuário conectar um segundo banco no Meu Pluggy, os cartões dos dois bancos vão aparecer misturados no mesmo item, cada banco com ciclo de fatura diferente.

Decisão arquitetural: criar uma entidade **"fatura"** acima dos grupos de cartão.

```
Fatura (closing_day, due_day, display_name)
  └── Grupo de cartão (nome, cor, quais card_last4)
        └── Transações
```

Cada fatura tem seu ciclo independente. Os cards de breakdown ficam dentro da fatura selecionada. O headline da tela vira um seletor de fatura ou tabs.

Implica: nova tabela, migração dos `card_settings` + `card_groups` existentes, refatoração do `/bills/current/breakdown` pra calcular janela por fatura, refatoração do frontend (seletor de fatura no topo).

## Fluxo de caixa (conta corrente)

Tela separada que projeta o saldo futuro da conta corrente. A fatura do cartão entra como saída na data de vencimento. Entradas e saídas manuais (salário, aluguel, freelas) são adicionadas pelo usuário.

Requer: novo schema (`manual_entries` ou similar), nova tela, possivelmente novas fontes de dados do Pluggy (accounts do tipo BANK). Discussão de schema necessária antes de implementar.

## Navegação entre faturas

Hoje só é possível ver a fatura atual (aberta). Adicionar setas ← / → ou um seletor de mês pra navegar em faturas fechadas. O `/bills` (faturas fechadas do Pluggy) já existe como cache local — a questão é construir a UI e ligar com o breakdown.

## Melhorias de categorização

- **Regras visíveis**: tela pra ver/editar/deletar as regras aprendidas (hoje só existe o endpoint `GET /rules`, sem UI)
- **Bulk smarter**: ao categorizar em lote, sugerir "aplicar a todos com mesmo merchant?" em vez de exigir seleção manual prévia
- **Categorias com ícone ou emoji**: além da cor automática, um identificador visual rápido

## UX / polish

- **Keyboard shortcuts no inbox**: `j`/`k` pra navegar, `Space` pra selecionar, `c` pra abrir picker, `u` pra desfazer
- **Busca de transações**: filtro por texto na descrição, dentro do inbox
- **Responsividade mobile**: os cards de breakdown e o inbox funcionam em telas pequenas mas não estão otimizados
- **Limpeza do sufixo PARCxx/yy**: strip global no shape de transação pra descrições mais limpas em toda a UI, não só nos cards de parcelamento

## Infraestrutura

- **Testes**: escolher runner (vitest? node --test?) e cobrir pelo menos billWindow, merchantSlug, e a sign convention
- **CHANGELOG**: manter atualizado conforme features aterrissam (formato Keep a Changelog, já existe o v0.1.0)
- **Deploy local simplificado**: script `start.sh` que roda `npm install` + `npm run dev` pra quem clonar o repo

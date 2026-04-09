# Roadmap

Ideas and planned features, roughly grouped by theme. Nothing here is committed — this is a thinking space for prioritization. When something moves to implementation, it gets a PR and leaves this list.

## Fatura por banco (arquitetura revisada, não implementada)

Hoje existe um único `card_settings` por `itemId` com um par `closing_day`/`due_day`. Quando o usuário conectar um segundo banco no Meu Pluggy, os cartões dos dois bancos aparecem misturados no mesmo item mas em **accounts separadas** — cada account do tipo `CREDIT` representa um produto de cartão de crédito de um banco específico.

Descoberta: `fetchAccounts(itemId)` sem filtro já retorna as accounts separadas com `name` legível (ex: "Pic Pay Mastercard Black", "Itaú Visa Platinum"). Cada transação já carrega `account_id`, então a separação por banco é automática — não precisa de entidade manual "fatura".

Arquitetura proposta:

```
Account CREDIT (detectada do Pluggy, name = "Pic Pay Mastercard Black")
  ├── closing_day, due_day (configurado uma vez pelo usuário por account)
  ├── Grupo "Eu"        → card_last4 pertencentes a essa account
  ├── Grupo "Esposa"    → ...
  └── Grupo "Virtual"   → ...
```

`card_settings` migra de per-`itemId` pra per-`accountId`. `card_groups` ganha FK pra `accountId` em vez de `itemId`. O frontend ganha um seletor de account (tabs ou picker) no topo; dentro de cada account, tudo funciona como hoje.

Dados já disponíveis na conexão atual:

| type | name | number |
|---|---|---|
| BANK | PicPay Instituição de Pagamento S.A | 00649316-5 |
| CREDIT | Pic Pay Mastercard Black | 3021 |

A account BANK (conta corrente) é relevante pro fluxo de caixa (ver seção abaixo).

## Fluxo de caixa (conta corrente)

Tela separada que projeta o saldo futuro da conta corrente. A fatura do cartão entra como saída na data de vencimento. Entradas e saídas manuais (salário, aluguel, freelas) são adicionadas pelo usuário.

Requer: novo schema (`manual_entries` ou similar), nova tela. A conexão Meu Pluggy **já fornece** uma account do tipo `BANK` / `CHECKING_ACCOUNT` com saldo — só não é sincronizada hoje porque o sync filtra por `'CREDIT'`. Chamar `fetchTransactions` na account BANK traria entradas e saídas da conta corrente (Pix, transferências, boletos).

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

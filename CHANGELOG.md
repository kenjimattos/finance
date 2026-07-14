# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.8.2] - 2026-07-14

### Corrigido

- **Entradas manuais "sumiam" do fluxo de caixa no dia alcançado pelo sync.** O dia da fronteira realizado/projetado (a última data com transação bancária) mostrava apenas os lançamentos reais do banco — as entradas manuais agendadas para esse dia eram ocultadas da visualização e do somatório, mesmo quando o lançamento correspondente ainda não tinha postado no extrato. Agora o dia da fronteira exibe ambos: as transações reais **e** as entradas manuais do dia, que voltam a contar no saldo. Dias estritamente anteriores à fronteira seguem escondendo as manuais (os dados reais já os cobrem), e a poda no sync continua preservando o mês corrente.

### Alterado

- **Conteúdo principal mais largo.** A largura máxima do `<main>` subiu de 1120px para 1200px, dando mais respiro às três colunas da divisão e aos cards de conta em telas grandes.
- **Coluna "dela" sem total redundante.** O subtítulo da coluna **dela** na divisão mostrava `Nx — total R$ x`, mas para essa coluna o total é sempre igual ao valor devido exibido logo acima; agora mostra apenas a contagem (`Nx`), como a coluna **meu**.
- **Totais da divisão mostram o delta vs mês anterior.** Abaixo de cada um dos dois totais da divisão (**meu** e **dela**) — e também abaixo do total de cada coluna (½ / dela / meu) — aparece a variação frente à fatura anterior, no mesmo estilo do total da seção cartões — `▲ R$ 120,00 vs anterior` (accent quando subiu, verde quando caiu, oculto sem variação). O split-summary devolve `previousPartnerOwes`, `previousMyShare` e um `previousBreakdown` por tipo; o Overview soma esses valores entre contas antes de calcular o delta.
- **Categorias mostram a variação mês a mês.** Cada categoria nas colunas da divisão (½ / dela / meu) e no breakdown da seção **cartões** do Overview passa a exibir, entre parênteses depois do valor, a diferença em relação à fatura anterior — ex.: `R$ 320,00 (+R$ 45)`. Categorias sem gasto no ciclo anterior aparecem como `(novo)`; sem mudança, nada é exibido. O split-summary devolve os totais por categoria do ciclo anterior (`prevHalfTotal`/`prevTheirsTotal`/`prevMineTotal`) e o breakdown de fatura devolve `previousTotal` por categoria; o Overview agrega esses valores entre contas antes de calcular a variação.
- **Divisão agora mostra os dois totais.** O headline da seção de divisão (Dashboard e Overview) deixa de exibir apenas quanto a parceira deve e passa a mostrar as duas partes lado a lado: **meu** (minhas transações + metade do valor dividido) e **dela** (transações dela + a outra metade). O valor "dela" continua sendo o mesmo `partnerOwes` de antes, agora com rótulo e em destaque na cor de acento.

## [1.8.1] - 2026-07-09

### Corrigido

- **Shifts de fatura "desconfigurando" sozinhos após o sync.** O Itaú publica parcelas futuras como lançamentos `PENDING` datados no _vencimento_ da fatura em que vão cair; para colocá-las na fatura certa, o usuário aplica `shift = -1`. Quando a parcela efetivamente posta, a Pluggy troca a data do lançamento (repost) — o sync atualizava a data preservando o shift, mas o shift é relativo à data, então o `-1` preservado passava a arrastar a linha para uma fatura antes da correta. Agora, quando um repost muda a data, o shift é **recalculado para manter a linha na mesma fatura-alvo**: se a data nova já cai naturalmente na fatura que o shift mirava, o override é removido; se a fatura-alvo ficou a mais de ±1 ciclo de distância, o override é limpo (com warning no log) e a linha fica no ciclo natural. Sem `account_settings` configurado, o comportamento antigo é mantido.

## [1.8.0] - 2026-06-30 

### Corrigido

- **Saldo do CashFlow mudava ao abrir/fechar o histórico — e o valor errado ia para o resumo.** O saldo corrente é acumulado só a partir dos meses carregados, ancorando no saldo de abertura do **primeiro mês visível**. Esse saldo de abertura era calculado ancorando no _snapshot de saldo mais próximo de cada mês_; como o campo de saldo da Pluggy oscila absurdamente em alguns conectores (o Nubank reporta valores pulando entre ~0 e milhares no mesmo dia), o mês atual ancorava num snapshot-lixo e o saldo não batia com o do banco. Ao abrir o histórico a âncora passava a ser um mês antigo somando todas as transações, o que reconcilia com o saldo real — daí "abrir o histórico conserta". Agora todo mês deriva de uma **única âncora**, então o saldo é idêntico independente do histórico estar aberto ou fechado.

### Adicionado

- **Âncora de saldo confirmada (`balance_anchors`).** O saldo de abertura passa a ser ancorado num valor **confirmado** pelo usuário (ex.: saldo real em 31/12/2025), rolando o histórico de transações por cima — imune à oscilação do campo de saldo da Pluggy. Usa a âncora mais recente da conta. Sem âncora, cai no saldo ao vivo rolado para trás. A tabela `balance_snapshots` deixa de participar do cálculo e vira apenas um **log de diagnóstico** das leituras de saldo da Pluggy (foi o que permitiu identificar a oscilação do Nubank). _Input de âncora na criação de conta ainda pendente._
- **Refresh anual automático da âncora.** No fim de cada sync bancário, o sistema congela uma âncora de fechamento (`YYYY-12-31`) para cada ano já completo e estabilizado, rolando a âncora mais recente para frente pela soma das transações do ano (valor **derivado**, nunca o saldo ao vivo da Pluggy). Isso mantém a janela de soma curta e — principalmente — preserva o cálculo caso a Pluggy expire transações antigas. Um ano só é congelado depois que os dados realizados passam de `Y+1-01-15` (folga para lançamentos de dezembro postarem). Idempotente e nunca sobrescreve uma âncora existente, então um re-aterramento manual contra o extrato real sempre vence.

## [1.7.1] - 2026-06-29

### Corrigido

- **Upload de fatura dando "request entity too large" (413) em produção.** O middleware que remove o prefixo `/api/` rodava _depois_ do parser de JSON, então em produção a rota de import chegava como `/api/transactions/import-fatura/...` e não casava com a exceção que concede o limite de 25 MB — caindo no parser default (~100 kb), que rejeitava os screenshots em base64. O proxy do Vite remove o `/api` no dev, o que mascarava o problema. Agora o prefixo é removido antes do parser, então o limite maior vale e o upload funciona. Não tinha relação com o modelo de visão.

## [1.7.0] - 2026-06-29

### Adicionado

- **Importar fatura por screenshots.** Novo botão no Dashboard ("importar fatura") que abre um modal onde você sobe os prints da fatura do app do cartão. As imagens são reduzidas no navegador (máx. 1568px) e enviadas ao Claude (visão), que lê cada linha e devolve as transações estruturadas: data, descrição, valor, cartão (últimos 4), parcela ("Parcela X de Y") e estorno (valores verdes viram negativos). Antes de gravar, aparece uma **tela de revisão editável** — dá pra ajustar qualquer campo, desmarcar linhas e conferir o total. Os lançamentos entram como `source='manual'`.
  - **Bill shift automático.** O import é contextual à fatura que você está vendo. Um lançamento cuja data cai naturalmente em outro ciclo (ex.: 17/06 numa fatura que fechou 16/06) é puxado para a fatura atual automaticamente, gravando o `bill_shift` correspondente. Cada linha mostra um seletor "nesta fatura (shift)" que vem ligado e pode ser desligado.
  - **Configuração.** A feature liga quando o servidor tem `ANTHROPIC_API_KEY` (com `ANTHROPIC_BASE_URL` e `ANTHROPIC_MODEL` opcionais). Sem a chave, o botão some e os endpoints respondem 503.

## [1.6.3] - 2026-06-19

### Fixed

- **Seletor de categorias abrindo a lista pra cima.** Quando o gatilho estava na metade de baixo da tela, o dropdown de categorias virava pra cima (flip), o que confundia. Agora, ao abrir, a página rola o mínimo necessário pra abrir espaço e a lista aparece sempre logo abaixo do gatilho (o flip pra cima fica só como último recurso em telas baixas demais). A rolagem automática não fecha mais o dropdown.
- **Teclado do mobile abrindo sozinho no seletor de categorias.** No Dashboard, abrir o dropdown de categorias dava `focus()` imediato no campo de busca, o que disparava o teclado virtual e cobria a lista antes do usuário escolher digitar. Agora o foco automático só acontece quando o ponteiro principal é um mouse/trackpad (`(pointer: fine)`); em telas de toque o teclado só aparece quando o campo de busca é tocado de propósito. O fluxo por teclado no desktop (digitar pra filtrar, setas, Enter) continua igual.

## [1.6.2] - 2026-06-19

### Added

- **Limpeza de lançamentos manuais realizados no sync.** Ao sincronizar as contas correntes (`POST /cashflow/sync`), o sistema agora remove as `manual_entries` de meses já totalmente cobertos por dados reais do banco — qualquer entrada de um mês anterior ao mês da última transação bancária realizada, além das linhas legadas sem `month` (que nunca eram renderizadas). O mês corrente é preservado para não apagar projeções que o banco ainda não alcançou. A resposta do sync passa a incluir `prunedManualEntries`.

### Changed

- **Ações de lançamentos manuais no CashFlow agora funcionam no mobile.** Os botões de duplicar (`++`, `+→`), remover (`×`) e esconder eram visíveis só no hover e escondidos no mobile (`hidden md:inline`), ficando inacessíveis em telas de toque e pouco descobríveis no desktop. Foram substituídos por um menu de ações "⋯" (o `RowActionsMenu` já usado na lista de transações), acionado por clique/toque — visível no desktop e operável no mobile. Os símbolos crípticos viraram rótulos legíveis ("Duplicar neste mês", "Duplicar no próximo mês", "Remover" em destaque, "Esconder do fluxo de caixa").

### Fixed

- **Divisão no Dashboard.** A seção "Divisão" deixava de aparecer quando nenhuma transação estava marcada como `½` ou `dela`. Agora, mesmo sem divisões, o quadro "meu" continua visível com a quebra de categorias do total da fatura.
- **Totais da divisão ignoram transações sem categoria.** Uma transação marcada como `½`/`dela` mas ainda sem categoria entrava nos totais dos cards de divisão (`partnerOwes`, total de cada coluna e contagens), violando a invariante de que só transações categorizadas somam. Agora ela é excluída dos totais, como já acontecia com o quadro "meu".

## [1.6.1] - 2026-05-21

### Added

- **Compartilhamento de divisão entre usuários parceiros.** O env var `USER_<NOME>_PARTNER=<outro_usuario>` declara que o usuário dono divide cartões de crédito com o parceiro indicado. O parceiro passa a enxergar, em modo somente leitura, as transações marcadas como `½` ou `dela` nos cartões do dono — cada cartão compartilhado aparece como um card a parte na Overview com o total que o parceiro deve, com drill-in que lista as transações, categorias e variação vs fatura anterior (também só leitura). A seção "compartilhados" da Overview também traz o total dos cartões por categoria, com colunas separadas para o que é `½` (metade) e o que é `dela`, e cada coluna lista as parcelas com o valor da parte do parceiro. CashFlow não é afetado; só cartões de crédito participam do compartilhamento. Novas rotas `GET /partner/cards` e `GET /partner/cards/breakdown` materializam a leitura cruzada direto da SQLite do dono, sem duplicar dados.

## [1.6.0] - 2026-05-17

### Added

- **Modo escuro.** Novo seletor de tema no header do Overview com três estados: `auto` (segue o sistema), `☼` (claro) e `☾` (escuro). A preferência é persistida em `localStorage` e aplicada antes do primeiro paint via script inline no `index.html`, evitando flash de tema. A paleta escura mantém o caráter editorial — "darkroom print" do papel quente original, com creme sobre preto-marrom e o mesmo laranja queimado (ligeiramente mais brilhante pra segurar o contraste no escuro). O overlay de grão também troca `mix-blend-mode` de `multiply` pra `screen` no escuro pra não virar lama.

### Fixed

- **Gerenciar bancos.** O menu agora agrupa por item Pluggy: cada conector aparece como header com suas contas (BANK + CREDIT) indentadas. Items órfãos (sem contas, restos de conexões falhas) também aparecem marcados como "sem contas" pra poderem ser removidos pelo próprio menu. O label de cada item tenta derivar o banco real (Itaú, Nubank, PicPay…) a partir dos nomes das contas, com fallback pro `connector_name` da Pluggy — útil no sandbox onde tudo vem como "Meu Pluggy".

### Added

- **Multi-usuário com SQLite por usuário.** A app deixou de ser single-tenant. Cada pessoa autentica com seu próprio par usuário/senha e o backend serve um arquivo SQLite isolado para cada uma.
  - Credenciais por env var no formato `USER_<NOME>_PASSWORD` (ex: `USER_KENJI_PASSWORD=...`). O nome em minúsculas vira o username de login e o nome do arquivo (`DATABASE_DIR/kenji.sqlite`).
  - `DATABASE_PATH` foi substituído por `DATABASE_DIR` (diretório onde os arquivos por usuário ficam).
  - `APP_PASSWORD` foi removido; sem nenhuma `USER_*_PASSWORD` definida, a app cai pra modo aberto com usuário "default" (preserva o fluxo de dev local).
  - Cookie de sessão agora carrega o username, assinado com HMAC; `SESSION_SECRET` opcional (mas recomendado em produção).
  - Tela de login ganhou campo de usuário.
  - Refactor: o singleton `db` foi extinto. `req.db` é injetado pelo `authMiddleware` e usado por todas as rotas; helpers que precisam de DB recebem `db: Db` como primeiro parâmetro.

### Migração (Railway)

1. Pare o serviço (replicas → 0).
2. Mova o arquivo existente: `mv /data/finance.sqlite{,-wal,-shm} /data/users/<seu-username>.sqlite{,-wal,-shm}`.
3. Substitua as env vars: remova `APP_PASSWORD` e `DATABASE_PATH`; adicione `DATABASE_DIR=/data/users`, `USER_<NOME>_PASSWORD=...` para cada usuário e (recomendado) `SESSION_SECRET`.
4. Suba o serviço.

## [1.5.2] - 2026-05-14

### Changed

- **Layout responsivo para mobile.** O app foi otimizado para uso em telas estreitas, sem custos no desktop:
  - **CashFlow:** a tabela de fluxo de caixa colapsa em mobile mostrando apenas as colunas essenciais (descrição + saldo); débito/crédito/dia ficam visíveis apenas a partir de `md:`. Os cabeçalhos "desktop-only" são ocultados na versão mobile e a coluna de valores ganhou variantes responsivas para caber sem quebrar.
  - **BillHeader:** os botões de ação ("gerenciar regras", "sincronizar") foram movidos para inline com a navegação de ciclo, e "gerenciar regras" é escondido em mobile (visível a partir de `md:`). O botão "adicionar banco" do Overview segue a mesma regra.
  - **SplitSection:** o grid das colunas (½ · dela · meu) agora é responsivo com breakpoints `md:`, evitando que as três colunas apertem em telas estreitas. Estilo de card com borda e `gap` reduzido.
  - **TransactionInbox:** os cabeçalhos de seção ("a categorizar", "categorizadas") e seus controles (filtro de categoria, "selecionar tudo") foram reorganizados para empilhar verticalmente em mobile e ficar inline a partir de `md:`, eliminando o aperto e o overflow horizontal no inbox da fatura.
  - **TransactionRow:** em mobile, as infos laterais (data, categoria, parcela, split) descem para uma segunda linha logo abaixo do valor, deixando a descrição com largura total na primeira linha. A partir de `md:` voltam ao layout inline original. O badge de parcela (`X/N`) foi movido para junto da descrição (em vez de ficar entre data e categoria), aproximando-o do contexto a que se refere.

### Docs

- **CLAUDE.md emagrecido; detalhes movidos para `docs/`.** O arquivo carregado em toda sessão era prosa longa repetindo mecânicas já implementadas; foi reduzido a invariantes, ponteiros e convenções, com o conteúdo de referência extraído para arquivos dedicados consultados sob demanda:
  - [docs/api.md](docs/api.md) — catálogo completo de endpoints (auth, items, sync, bills, transactions, cash flow).
  - [docs/pluggy.md](docs/pluggy.md) — gotchas do SDK da Pluggy (sign convention, shape de `cardNumber`, "pagamento recebido", datas de parcelas).
  - [docs/sync.md](docs/sync.md) — engine de sync: identidade de transação, janela de fatura aberta, mecânica de `bill_shift`, regra "só categorizadas somam", learning loop.
  - [docs/frontend.md](docs/frontend.md) — design editorial, hierarquia de telas e catálogo de padrões reusáveis (overlays via portal, toasts, `SplitSection`).
  - [docs/schema.md](docs/schema.md) — modelo de dados detalhado, sister tables e a armadilha do `INSERT OR REPLACE` em tabelas de cache.
  - "Current state" foi colapsado em uma checklist de bullets (um por área de feature) e a seção "Out of scope" foi removida.

## [1.5.1] - 2026-05-14

### Added

- **Total das parcelas exibido acima da lista, no Dashboard e no Overview.** Cada coluna da seção "Divisão" (½, dela, meu) que tem parcelas agora mostra um cabeçalho `parcelas · N` com a soma dos valores das parcelas daquela coluna, alinhado à direita no mesmo estilo monoespaçado das demais cifras.

- **Transações manuais de cartão podem ser marcadas como parceladas.** O formulário de lançamento manual no inbox da fatura ganhou um campo "Parcela" (`X / N`). Os dois valores se movem como par — ambos preenchidos ou ambos vazios — e são gravados nas colunas `installment_number` / `total_installments` da tabela `transactions`, as mesmas usadas pelas parcelas vindas da Pluggy. Com isso a linha manual exibe o badge `X/N` e participa do breakdown de parcelas da fatura e do split exatamente como uma linha sincronizada. O modelo é "linha única por parcela": cada ciclo é uma linha independente (espelha como a Pluggy entrega parceladas), sem auto-expansão em N faturas. `POST`/`PUT /transactions/manual` aceitam `installmentNumber`/`totalInstallments` (opcionais, validados juntos; passar ambos `null` no PUT limpa a marcação).

### Changed

- **Seção "Divisão" unificada em um único componente.** O Dashboard e o Overview mantinham duas implementações quase idênticas da seção de split — `SplitSummaryCard` em `SplitSummaryPanel.tsx` e `SplitSection` inline em `Overview.tsx`, com colunas, listas de categoria/parcela e `stripInstallmentSuffix` duplicados. Agora há um único componente presentational `SplitSection` em `components/SplitSection.tsx` com uma prop `variant` (`'card'` no Dashboard, `'section'` no Overview) que controla escala, eyebrow e espaçamento. Cada tela faz seu próprio fetch/agregação e passa os dados normalizados (`totalCount`, antes `totalSplitTransactions` no Dashboard). `SplitSummaryPanel.tsx` foi removido; as props mortas `year`/`month` da versão do Overview também. O toggle "+N mais" do Overview agora usa o mesmo estilo em caixa alta do Dashboard.

### Fixed

- **Drag-and-drop do fluxo de caixa: mover para baixo agora respeita uma posição por vez.** A lógica de reordenação inseria sempre *antes* do item sob o cursor, ignorando a direção do arraste — então mover uma linha para baixo em um slot era no-op (o item alvo apenas subia para o espaço vago) e o usuário precisava mirar duas linhas abaixo. `applyReorder` agora detecta a direção pelos índices da lista plana e insere *depois* do alvo quando o arraste é para baixo, espelhando a semântica do `arrayMove` do dnd-kit.

## [1.5.0] - 2026-05-14

### Added

- **Drag-and-drop para reordenar linhas no fluxo de caixa.** Cada linha arrastável (transações bancárias e entradas manuais) exibe um handle "⋮⋮" no hover, à esquerda da linha. Arrastar permite reposicionar dentro do mesmo dia; para entradas manuais, também é possível mover entre dias (atualiza `day_of_month` automaticamente). Transações bancárias da Pluggy ficam restritas ao mesmo dia — qualquer drag entre dias é ignorado. Faturas de cartão (`credit_card_bill`) não são arrastáveis. A cada drop, os `sort_key` dos dias afetados são reescritos em múltiplos de 1000 (n × 1000), preservando margem para inserções futuras. UI otimista atualiza o cache da query antes das chamadas REST resolverem.

- **Endpoints para atualizar `sort_key` no fluxo de caixa.** `PUT /bank-transactions/:id/sort-key { sortKey: number | null }` para transações bancárias; `PUT /manual-entries/:id` agora aceita `sortKey: number | null` junto com os demais campos. Null restaura a ordem natural.

- **Coluna `sort_key` para ordenação manual no fluxo de caixa.** Adicionada a `bank_transactions` e `manual_entries` (REAL, nullable). `GET /cashflow` agora ordena dentro de cada dia por `COALESCE(sort_key, ∞)`/`COALESCE(sort_key, id*1.0)` — quando nulo, mantém a ordem natural anterior; quando preenchido, controla a posição. Preparação para o drag-and-drop de linhas no CashFlow.

- **Hide flag for visually-duplicate bank rows.** Pluggy sometimes returns one conceptual bank charge as two distinct transactions with different `provider_id`s, dates, and descriptions (e.g. the same Comgas debit appearing as `"DA  COMGAS 65363710"` on one day and `"Débito automático DA COMGAS 65363710"` on the next). Both are legitimate to Pluggy; no heuristic can safely merge them without false positives elsewhere. A new `bank_transaction_hidden` table lets the user mark a row as a known duplicate; the row stays in `bank_transactions` (so subsequent syncs still touch it and balance snapshots stay consistent) but is excluded from both the `/cashflow` listing and the running-balance sums. Surfaced as a hover-only "esconder" button on every bank row in the CashFlow ledger. Reversible via `DELETE /cashflow/hide/:id` (no UI for un-hide yet).

### Changed

- **Cash-flow realized/projected boundary is now a single global date.** Previously each month's `GET /cashflow` computed its own boundary from `MAX(date)` of that month's bank transactions — so a month whose bank data ended early (a connector gap, or the user hiding the tail-end rows) had the rest of the month treated as "future" and got synthetic credit-card-bill outflows injected into days that were actually in the past, double-counting against the real `Pagamento de fatura` bank row. The boundary is now `lastRealizedDate` = `MAX(date)` across **all** bank transactions, every account and every month (hidden rows still count — hiding is a display choice). A day is realized when `date <= lastRealizedDate` and projection territory otherwise. Credit-card bills only project when their due date is strictly after `lastRealizedDate`. Deliberately not tied to today's date: if syncing stalls, the boundary stalls with it instead of marking un-synced days as empty-but-realized.

- **Removed the description-based exclusion filter for BANK transactions.** `BANK_TX_EXCLUDE_DESCRIPTIONS` was a static substring blocklist (`Retirada de saldo por lastro`, `Recarga em carteira via Cartão de Crédito`, `COM CARTAO`) applied to every `/cashflow` listing and balance sum. It could only catch connector-noise rows with a *constant* description, which left it structurally unable to handle PicPay's recarga/lastro "trios": the credit-card-funded leg of such a trio is a normal PIX whose description is the recipient's name (no stable string to match), so the filter excluded the two bookkeeping legs but kept the spend — silently throwing off the running balance. The cash-flow exclusion mechanism is now solely the explicit `bank_transaction_hidden` flag: the user hides connector noise by hand, which is unambiguous and reversible.

- **BANK transactions moved out of the shared `transactions` table.** Bank and credit-card transactions now live in separate tables (`bank_transactions` + `transactions`) with separate sync paths, because their identity models diverge: credit-card `provider_transaction_id`s are observed to be recycled across installment refreshes, while bank ones are stable but the surrounding fields (description, date) drift as Pluggy enriches metadata between syncs. The shared dedup heuristic (date + amount + merchant slug hash) was generating false positives on BANK whenever Pluggy enriched a description (e.g. `"TED D INT5c20eee1"` → `"TED enviada Kenji Mattos Kinoshita"`), inserting a duplicate row under the same provider_id.
  - `POST /cashflow/sync` now uses a naive provider_id-keyed upsert against `bank_transactions`: if Pluggy returns a known `provider_transaction_id`, every mutable field is overwritten in place (date, description, amount, status, raw_json); otherwise insert. No identity hash, no recycle-detection branch.
  - The bill-tag and description-override join tables for BANK rows moved to their own siblings (`bank_bill_payment_tags`, `bank_transaction_description_overrides`).
  - `PUT/DELETE /transactions/:id/description` (only ever used for BANK) was replaced by `PUT/DELETE /bank-transactions/:id/description`. Frontend updated.
  - `POST /transactions/sync` no longer fetches BANK transactions (it still upserts BANK account metadata and balance snapshots).

### Migration

- An idempotent migration moves existing BANK rows from `transactions` to `bank_transactions`, repoints attached description overrides and bill tags to the new sister tables, and dedupes by `provider_transaction_id` (keeping the most recently seen row, migrating user work from stale rows before deleting them). The migration only runs while BANK rows still exist in `transactions`; subsequent boots are a no-op.

## [1.4.0] - 2026-05-12

### Added

- **Rota temporária `POST /admin/restore-db`**: aceita o conteúdo binário de um `.sqlite` (até 100mb) via body raw, faz backup do arquivo existente (`<path>.bak.<ts>`) e sobrescreve `DATABASE_PATH`. Apaga os sidecars `-wal`/`-shm` para não reabrir o estado antigo. Usada uma única vez no deploy do Railway para popular o volume com o banco local; será removida após o seed. Protegida pelo `APP_PASSWORD` via `authMiddleware`.
- **"Selecionar todas" na seção "Já categorizadas"**: o botão já existia em "A categorizar"; agora a seção de transações já categorizadas também tem seu próprio toggle de seleção em massa, permitindo aplicar split ou recategorizar todas as visíveis de uma vez.

### Fixed

- **Sync: PENDING→POSTED com mudança de data duplicava a transação**. Quando uma parcela transicionava de `PENDING` (data futura prevista) para `POSTED` (data real do posting), o `provider_transaction_id` permanecia o mesmo mas o hash de identidade mudava (data faz parte do hash). A lógica anterior tratava isso como "ID reciclado" e inseria uma row nova mantendo a antiga, duplicando o lançamento. Agora, quando o `provider_id` existe e o hash difere mas `amount` + `merchantSlug` batem, a row é atualizada in-place (data nova, hash novo) — preservando categoria/split/shift do usuário.
- **Sync: colisão de hash perdia transações distintas no mesmo dia/valor/merchant**. O slug do merchant era truncado em 3 tokens, então `"ZUL 1 cartao 22LNBF"` e `"ZUL 1 cartao 22LBLK"` (duas sessões de estacionamento reais, mesmo dia, mesmo valor) geravam o mesmo hash de identidade e uma sobrescrevia a outra a cada sync. Limite agora é 5 tokens, preservando o discriminador final. Hashes existentes recomputados via `recompute-hashes.ts`.
- **Overview: saldo projetado para meses futuros**. Antes o cálculo era `openingBalance(do mês alvo) + entradas do mês alvo`, mas `openingBalance` retornado pela API é o saldo *atual* do banco — não o saldo projetado para o início daquele mês futuro. Agora, quando o mês selecionado é futuro, o Overview busca em paralelo todos os meses intermediários e acumula o running balance sequencialmente (mesma lógica usada pelo CashFlow), produzindo um saldo projetado correto.

## [1.3.3] - 2026-04-27

### Added

- **Deploy no Railway**: `railway.toml` com build/start/healthcheck. Express serve o build do Vite como arquivos estáticos em produção (`NODE_ENV=production`), eliminando a necessidade de Nginx ou processo separado.
- **`.npmrc` com `legacy-peer-deps=true`**: garante que `npm install` funcione no Railway sem falhar nas peer deps do React 19.
- **Proteção por senha**: variável de ambiente `APP_PASSWORD` ativa autenticação em toda a API. Quando definida, todas as rotas retornam 401 sem o cookie de sessão válido. Se ausente, auth é desabilitada (dev local). Rotas públicas: `GET /health`, `GET /auth/me`, `POST /auth/login`, `POST /auth/logout`.
- **Cookie de sessão persistente**: `httpOnly`, `SameSite=strict`, `Secure` em produção, `maxAge` de 10 anos — sem expiração para uso pessoal. Token é um HMAC-SHA256 determinístico da senha; trocar `APP_PASSWORD` invalida todos os cookies existentes automaticamente, sem banco de sessões.
- **Tela de login**: exibida antes de qualquer conteúdo carregar quando o usuário não está autenticado. Estilo editorial do projeto — campo de senha com borda inferior, botão sublinhado, mensagem de erro inline.

### Changed

- **`DATABASE_PATH` obrigatório via env**: o caminho do SQLite saiu do código e virou variável de ambiente obrigatória — sem ela a API falha na inicialização. Localmente configurado em `.env` (`data/finance.sqlite`), no Railway apontará para o volume persistente (`/data/finance.sqlite`).
- **`CORS_ORIGIN` agora opcional**: quando não definida, o middleware de CORS é ignorado. Em produção (frontend e API na mesma origem), a variável não precisa ser configurada.
- **Helmet sem CSP**: `contentSecurityPolicy: false` para compatibilidade com o SPA servido pelo Express.

## [1.3.2] - 2026-04-27

### Added

- **Dashboard: soma dos valores selecionados na barra de ação em lote**: ao marcar checkboxes no inbox, a barra flutuante exibe o total em BRL ao lado da contagem. Soma `t.amount` direto (DEBIT positivo, CREDIT negativo) — útil para conferir antes de aplicar categoria/divisão em lote.
- **Overview: botão de remoção de banco**: `RemoveBank` aparece no cabeçalho da toolbar ao lado do `ManageBankButton`, permitindo remover uma conexão bancária sem precisar entrar em configurações separadas.

### Changed

- **Dashboard: navegação de fatura permite avançar**: a seta "→" do `BillHeader` deixa de travar em `offset = 0` e é habilitada quando o próximo ciclo tem lançamentos (incluindo shifts ±1). O backend retorna `hasNextBillTransactions` em `GET /bills/current/breakdown`, computado com o padrão shift-aware de três janelas. Os labels "fecha em/fechou em" e "vence em/venceu em" passam a derivar da data real vs hoje, já que ciclos futuros são navegáveis.
- **Overview: navegação de mês permite avançar**: a seta "→" deixa de travar em `defaultMonth + 1` e é habilitada quando o mês seguinte tem lançamentos reais no fluxo de caixa (`bank_transaction` ou `manual_entry`). Atividade de cartão fica fora do critério — `credit_card_bill` existe para todo mês futuro configurado e seria sempre verdadeiro.
- **Overview: `ManageBankButton` consolida ações de banco num dropdown**: o card "adicionar banco" saiu do grid e virou um botão inline na toolbar (`+ Adicionar banco` / `Remover`). Simplifica a gestão sem ocupar espaço no grid de contas.
- **CashFlow: projeções múltiplas com `+ projetar mês` / `− remover último`**: o toggle único foi substituído por controles incrementais que permitem estender a visualização em até 12 meses. A quantidade é persistida em `localStorage` (`cashflow:projectionCount`). Meses com dados bancários reais não têm botão de remover.

## [1.3.1] - 2026-04-24

### Changed

- **Dashboard sem breakdown por grupo de cartão**: a seção "Divisão" agora supre a necessidade de entender como a fatura se distribui, então a grade de cartões-por-grupo foi removida. O endpoint `GET /bills/current/breakdown` retorna um objeto único (`total`, `previousTotal`, `delta`, `categories`, `installments`) em vez de um array `groups[]`. No frontend, `BillCardGrid` foi substituído por `BillHeader` (headline editorial com navegação de ciclo) e `CardGroupFilterBar` (chips para filtrar a lista por grupo + botão "gerenciar"). O mecanismo de agrupar cartões continua — só não dirige mais totais por cartão.
- **Seções padronizadas acima do inbox**: Divisão, Cartões e Categorias agora compartilham a mesma cabeçalho (ponto laranja + título em accent uppercase + contagem entre parênteses em mono) e ficam separadas do bloco anterior com `rule-top mt-10 pt-6`.
- **`account_id` de grupos de cartão realinhados**: `card_groups` e `card_group_members` cujos `account_id` apontavam para contas que não existem mais foram re-apontados para a conta CREDIT atual do mesmo item (via SQL direto no banco do usuário).

### Removed

- **Botão "copiar para splitwise"**: o export via clipboard foi removido do painel de Divisão no Dashboard e no Overview. Não haverá integração com Splitwise e a funcionalidade não estava sendo usada. Também limpamos a função `copyToClipboard`, estado `copied`, helpers `formatDay`/`formatDueDateLabel`, a acumulação de transações no split agregado e os props `displayName`/`dueDate` do `SplitSummaryCard`.
- **`ROADMAP.md`**: arquivo de roadmap removido do repositório — planejamento passou a viver fora do repo.

## [1.3.0] - 2026-04-24

### Added

- **UUID local como chave primária de transações**: `transactions.id` é agora um UUID gerado localmente (estável para sempre). O ID do Pluggy migrou para `provider_transaction_id`, que é non-unique e nullable para transações manuais. Migração automática no startup reemite UUIDs para todas as linhas existentes e reaponta as 5 tabelas de trabalho do usuário (`transaction_categories`, `transaction_bill_overrides`, `transaction_description_overrides`, `bill_payment_tags`, `transaction_splits`).
- **Lógica de sync em 3 vias**: ao sincronizar, cada transação do Pluggy segue um de três caminhos — (1) provider ID novo → INSERT com UUID local novo; (2) mesmo provider ID, hash igual ou NULL → UPDATE apenas campos mutáveis; (3) mesmo provider ID, hash diferente → ID reciclado pelo Pluggy: mantém linha antiga intacta, insere nova linha com UUID novo e registra auditoria em `transaction_sync_conflicts`.
- **Tabela de auditoria `transaction_sync_conflicts`**: registra cada evento de reciclagem de ID com os payloads antigo e novo para diagnóstico futuro.
- **Identity hash portável entre reconexões**: o hash de identidade (`SHA-256(date|amount|merchant_slug)`) não inclui mais `account_id`, tornando-o portável quando o Pluggy emite novos IDs de conta ao reconectar o mesmo banco. Um fallback `findByIdentityHash` no sync detecta a reconexão e faz UPDATE em vez de INSERT, preservando categorias, splits e overrides existentes.
- **Swap cirúrgico de item/conta no banco**: scripts de migração para substituir IDs de item e de contas Pluggy em todas as tabelas relacionadas (`items`, `accounts`, `transactions`, `bills`, `account_settings`, `balance_snapshots`, `card_groups`, `card_group_members`, `card_settings`) atomicamente com `PRAGMA foreign_keys = OFF`.

### Changed

- **Hash de identidade sem `accountId`**: a fórmula anterior incluía o account ID do Pluggy, o que tornava o hash inválido após reconexão. A nova fórmula (`date|amount|slug`) é estável mesmo com account IDs diferentes para o mesmo cartão físico.
- Sync (CREDIT e BANK) não usa mais `INSERT OR REPLACE`. Todas as escritas passam pela lógica de 3 vias para preservar o trabalho do usuário.

## [1.2.1] - 2026-04-23

### Added

- **Tipo de transação manual**: formulário de lançamento manual aceita agora crédito ou débito. O campo "tipo" distingue compras (débito) de estornos/créditos, e o valor é armazenado com o sinal correto para que o saldo da fatura reflita a operação.
- **Campo de ano editável**: o formulário de data de transações manuais inclui agora um campo de ano, permitindo registrar lançamentos em anos diferentes do corrente (útil para notas de anos anteriores ou ajustes retroativos).

## [1.2.0] - 2026-04-23

### Added

- **Bill splitting (Splitwise prep)**: mark transactions as shared with a partner — "½" (50/50) or "→dela" (partner owes 100%). Per-row actions in the ⋯ menu plus bulk split buttons in the selection bar. Backend: `PUT/DELETE /transactions/:id/split`, `POST /transactions/bulk-split`, `POST /transactions/bulk-unsplit`, `GET /bills/current/split-summary` (with categories + installments). Data stored in `transaction_splits` join table (survives re-syncs).
- **Split summary in Dashboard**: per-account "Divisão" section below the card grid with partner debt total, half/theirs/meu columns, category breakdowns, installments, and "copiar para Splitwise" button.
- **Aggregated split summary in Overview**: all-account "Divisão" section for the selected due month, combining split totals, categories, installments, and copy text across cards.

### Changed

- **Implicit "mine" split model**: categorized transactions without a split row are treated as "meu" in split summaries. The persisted split types are now only `half` and `theirs`; unmarking a split returns a transaction to implicit mine.
- **Split summary layout**: categories and installments are grouped into separate ½, dela, and meu columns with column totals and full-amount breakdowns.
- **Dynamic split columns**: split sections only render the columns that have data, keeping one- and two-column states compact.

### Fixed

- **Pluggy recycled transaction IDs**: sync detects when Pluggy reuses an existing transaction ID for different transaction content, clears dependent user joins for that stale row, and replaces it safely instead of preserving mismatched categorization/split data.
- **Split summary placement**: the Dashboard split summary now sits below the bill card grid instead of being embedded as a grid card.

## [1.1.0] - 2026-04-21

### Added

- **Manual bill transactions**: add, edit, and delete manual transactions directly in the credit card bill inbox when Pluggy fails to return them. Manual entries participate in all bill window queries, categorization, shifts, and breakdown totals. Marked with an orange "manual" badge; edit/delete via the ⋯ menu. API: `POST/PUT/DELETE /transactions/manual`.
- **Cashflow-only sync button**: sync bank account transactions without triggering a full credit card sync, for faster balance updates on the CashFlow screen.

### Changed

- **Compact date fields**: replaced native date input with compact day/month fields for manual bill transaction entry.

### Fixed

- **Paginated transaction fetch**: sync now fetches all pages from Pluggy's `fetchTransactions`, fixing incomplete data when accounts have more than one page of transactions.
- **Cashflow cutoff boundary**: uses the data coverage boundary (last transaction date) instead of today's date to determine the realized/projected cutoff, preventing gaps when Pluggy data lags behind.
- **Vite dev server port**: updated from 5173 to 5174 to avoid conflicts.

## [1.0.0] - 2026-04-13

The app now covers both sides of personal finance — credit card bills (categorization, multi-bank) and checking account cash flow (realized + projected) — in a single Overview landing page.

### Added

#### Overview as landing page (Caixa + Cartões)

- **Overview is now the top-level screen**, divided into two editorial sections:
  - **Caixa** — monthly cash flow summary: saldo (realized, based on last past day), entradas, saídas (excluding faturas) with delta vs previous month, faturas highlighted in accent color. "ver extrato →" drills into the full CashFlow ledger.
  - **Cartões** — all credit card bills grouped by due-month: grand total with delta, aggregated category breakdown with proportional bars, per-account cards with closing/due dates.
- **Next-month projection**: ←/→ navigation goes one month into the future. Future months show projected saldo based on manual entries + credit card bill outflows. Label switches to "saldo projetado".

#### CashFlow improvements

- **Dynamic month range**: fetches actual date range of BANK transactions from `GET /cashflow/range`. Only months with data are shown.
- **History toggle**: previous months hidden by default behind "mostrar N meses anteriores" (up to 5).
- **Projection month**: "+ projeção" toggle at the bottom shows the next month's projected entries, fully editable and independent.
- **Per-month manual entries**: manual entries now belong to a specific month (`month` column). Editing in one month does not affect others. Each month has its own "nova entrada" ghost row.
- **Duplicate entries**: `++` duplicates within the same month, `+→` duplicates to the next month. Compact monospace buttons on hover.
- **Bill payment tagging**: click the source/origin column on any realized bank transaction to toggle it as a credit card bill payment. Tagged entries show an accent-colored "fatura" label. Both auto-detection (description matching) and manual tags feed the Overview's faturas total.
- **Balance snapshots** (`balance_snapshots` table): records the Pluggy-reported bank balance at each sync. Historical months use the nearest snapshot as anchor for opening-balance calculations, staying accurate even after Pluggy ages out old transactions.

### Changed

- App routing: Overview (landing) → CashFlow or Dashboard (both with back buttons).
- Main content area widened from 960px to 1120px for more room in the CashFlow ledger.
- Saídas in the Caixa section now excludes faturas (shown separately) to avoid double-counting.

### Fixed

- Caixa saldo reflects realized balance only (opening + past bank transactions), not projections.
- Opening balance uses the closest balance snapshot (before or after target month), fixing ~R$ 346 drift on older months.

## [0.2.0] - 2026-04-12

### Added

#### Phase 4 — Multi-bank overview

- **Overview screen** (`Overview.tsx`): groups all credit card bills by due-month across all banks. ←/→ arrows navigate between months. Grand total with delta vs previous period at the top, aggregated category breakdown with proportional bars, one card per account showing total + delta + closing/due dates.
- **`findOffsetForDueMonth` helper**: given card settings and a target year+month, returns the bill offset whose due date falls in that month. Backend + lightweight frontend mirror. 7 new tests (55 total).
- **Add/remove bank in Overview**: "Adicionar banco" card opens PluggyConnect to connect a new item. "remover" button on each card with confirmation deletes the item via `DELETE /items/:id` with cascade cleanup. Unconfigured accounts render as "Configurar →" cards that drill into the setup form.
- **Dashboard back navigation**: `onBack` prop renders a "← voltar" button. Month state lifted to App so returning preserves the month being browsed.
- **Sync-all button** in Overview: fetches all items in parallel, then invalidates all queries.
- **Foreign-currency support**: `amountInAccountCurrency` from Pluggy is now stored and used for display and sums, so USD transactions show their BRL equivalent instead of raw dollar amounts.

#### Phase 3 — Depth in the current experience

- **Bill-cycle navigation**: ← / → arrows browse past bills. `computeBillWindowAtOffset(settings, offset)` is the core primitive; breakdown endpoint accepts `?offset=N`. Labels switch to past tense with month/year.
- **Rules management UI**: full-screen overlay via "regras" button — debounced search, inline category reassignment, delete with toast. Backend: `GET /rules?q=` filtering + `PATCH /rules/:id`.
- **Slug granularity improvement**: token after `*` preserved when ≥ 3 alphabetic chars ("UBER *EATS" → "UBER EATS" vs "UBER *TRIP" → "UBER TRIP"). Legacy slugs tried as fallback.
- **Majority-wins rule resolution**: `applyLearnedRules` picks the rule with the highest `hit_count` per slug instead of arbitrary insertion order.

#### Phase 2 — Per-account billing

- **`accounts` table**: populated during sync from `fetchAccounts(itemId, 'CREDIT')`.
- **`account_settings`**: per-account `closing_day` / `due_day`, replacing per-item `card_settings` (with backfill migration).
- **Account selector tabs**: shown when a single item has multiple CREDIT accounts.
- **Per-account breakdown and transactions**: all queries scoped by `accountId`.

#### Phase 1 — Stability

- **Test suite**: 28 tests covering `billWindow` and `merchantSlug`. Zero new dependencies.
- **`applyLearnedRules` tests**: 11 cases against in-memory SQLite. Locks the non-overwrite invariant.

### Changed

- Dev servers (Vite + Express) now bind to `0.0.0.0`, allowing access from other devices on the local network.
- **`applyLearnedRules` extracted** into its own service module, taking a `Database` parameter for testability.
- **Additive bill-shift model**: ⋯ menu buttons add ±1 to the current shift (capped at ±1) instead of setting absolutely. "Restaurar para esta fatura" appears naturally when undoing.
- `previousTotal` in breakdown is now shift-aware on both sides.
- App routing: Onboarding → Overview → Dashboard drill-down (was Onboarding → Dashboard).

### Fixed

- `PARCxx/yy` installment suffix stripped in `shapeRow` (API layer) instead of only in the frontend.
- `INSERT OR REPLACE` replaced with `ON CONFLICT UPDATE` in sync to avoid cascade-deleting user work.
- Foreign-currency transactions (USD) now display and sum in BRL via `COALESCE(amount_in_account_currency, amount)`.
- Transaction `item_id` realigned when an account moves between Pluggy items (sandbox re-connection scenario).

## [0.1.0] - 2026-04-09

First minimally functional version. End-to-end flow from connecting a card to categorizing transactions with learned rules and seeing per-group breakdowns.

### Added

- **Pluggy integration**: connect a credit card via the Pluggy Connect widget (Meu Pluggy supported), sync transactions and closed bills, cache everything locally in SQLite.
- **Open-bill calculation**: reconstructs the currently open bill window from user-configured `closing_day` and `due_day`, since Pluggy does not expose open bills.
- **User-defined categories**: flat list with auto-assigned colors from a curated palette. Create inline from the category picker by typing a name that doesn't exist yet.
- **Learning loop**: every manual categorization trains a `merchant_slug → category` rule. Future transactions with the same slug are auto-categorized on sync, tagged "auto". Two user corrections disable a bad rule automatically.
- **Bulk categorization**: select multiple transactions and assign a category in one action. Each assignment feeds the learning engine individually.
- **Clear category**: remove a category assignment from a transaction, returning it to "uncategorized" (and excluding it from bill totals).
- **Categorized-only totals**: bill totals sum only categorized transactions. Uncategorized rows (noise like "pagamento de fatura") stay visible but don't count. No "ignore" flag needed — absence of category is the exclusion.
- **Card groups**: group physical cards (titular, adicional, virtual) by their last 4 digits. Each group gets its own card on the dashboard with independent totals, category breakdowns, and installment listings.
- **Per-group category breakdown**: each card shows categories ordered by total with proportional 2px bars. Capped at 4 with a "+ N mais" / "− recolher" toggle.
- **Per-group installments**: each card lists parceladas landing in the current bill, with the `PARCxx/yy` suffix stripped from the description at render time. Same 4-row cap with expand.
- **Bill-cycle shifts**: move individual transactions to the previous or next bill cycle when the purchase date doesn't match the actual billing date. Shifted rows disappear from the current list; a 6-second undo toast provides recovery.
- **Dashboard layout**: editorial headline (Fraunces 96px) with the overall total, per-group card grid below, category tabs that filter the transaction list, and the categorization inbox with bulk selection bar.
- **Category tabs**: horizontal row derived from the selected card's breakdown. Filters the transaction inbox client-side.
- **Card groups management modal**: create, rename, delete groups; assign cards to groups via dropdown.
- **Card last 4 digits**: extracted from `creditCardMetadata.cardNumber`, normalized, shown inline on each transaction row.
- **Toast system**: global snackbar with optional undo action, 6-second auto-dismiss, hover pauses countdown.
- **Row actions menu**: trailing "⋯" on each transaction row, portal-positioned, hosts the bill-shift commands.
- **Onboarding screen**: editorial landing page with one-click Pluggy Connect widget integration.
- **Card settings setup**: one-time form for `closing_day`, `due_day`, and optional display name.
- **Design system**: light warm-paper theme (`#fbf8f4`), burnt-orange accent (`#c2410c`), Fraunces / JetBrains Mono / Inter type trio, fixed paper-grain overlay, vertical margin rule.

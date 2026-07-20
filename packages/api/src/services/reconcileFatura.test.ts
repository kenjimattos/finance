import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileFatura,
  descSimilar,
  isPaymentLine,
  type AppLine,
  type StatementLine,
} from './reconcileFatura.js';

function st(partial: Partial<StatementLine> & { amount: number }): StatementLine {
  return {
    date: '2026-07-01',
    description: 'MERCHANT',
    cardLast4: null,
    installmentNumber: null,
    totalInstallments: null,
    ...partial,
  };
}

let nextId = 0;
function app(partial: Partial<AppLine> & { amount: number }): AppLine {
  return {
    id: `app-${nextId++}`,
    date: '2026-07-01',
    description: 'MERCHANT',
    cardLast4: null,
    installmentNumber: null,
    totalInstallments: null,
    source: 'manual',
    category: 'Compras',
    ...partial,
  };
}

describe('descSimilar', () => {
  it('matches statement truncation vs app truncation of the same merchant', () => {
    assert.equal(descSimilar('171 - RIACHUELPARC01/03', '171 - Riachuelo - Sb C Sao Bernardo Bra'), true);
    assert.equal(descSimilar('PERNAMBUCANAS PARC01/05', 'Pernambucanas Sao Bernardo Bra'), true);
    assert.equal(descSimilar('AMAZONMKTPLC*MPARC02/05', 'Amazonmktplc*mparc02/05'), true);
  });

  it('rejects different merchants', () => {
    assert.equal(descSimilar('CARREFOUR SP CSB 335', 'Sacolao Saude'), false);
  });
});

describe('isPaymentLine', () => {
  it('detects both payment phrasings', () => {
    assert.equal(isPaymentLine('PAGAMENTO DE FATURA'), true);
    assert.equal(isPaymentLine('Pagamento recebido'), true);
    assert.equal(isPaymentLine('Posto Pagamento Legal'), false);
  });
});

describe('reconcileFatura', () => {
  it('matches same amount + same date', () => {
    const r = reconcileFatura(
      [st({ amount: 354.42, date: '2026-06-20', description: 'GALETERIA METROPOLIS' })],
      [app({ amount: 354.42, date: '2026-06-20', description: 'Galeteria Metropolis' })],
    );
    assert.equal(r.matched.length, 1);
    assert.equal(r.missingInApp.length, 0);
    assert.equal(r.onlyInApp.length, 0);
  });

  it('matches parceladas by installment pair across different dates', () => {
    // Statement keeps the original purchase date (24/08/2025); the app books
    // the installment on the closing date.
    const r = reconcileFatura(
      [st({ amount: 169.7, date: '2025-08-24', description: 'ZP *CPARC11/12', installmentNumber: 11, totalInstallments: 12 })],
      [app({ amount: 169.7, date: '2026-07-16', description: 'Zp *cparc11/12', installmentNumber: 11, totalInstallments: 12 })],
    );
    assert.equal(r.matched.length, 1);
  });

  it('matches same amount a few days apart (posting delay)', () => {
    const r = reconcileFatura(
      [st({ amount: 133.37, date: '2026-07-09', description: 'OBA HORTIFRUTI SAO BER' })],
      [app({ amount: 133.37, date: '2026-07-10', description: 'Oba Hortifrutti S o Ber' })],
    );
    assert.equal(r.matched.length, 1);
  });

  it('flags cent drift on the same installment as a mismatch, not missing', () => {
    const r = reconcileFatura(
      [st({ amount: 150.65, date: '2026-06-27', description: '171 - RIACHUELPARC01/03', installmentNumber: 1, totalInstallments: 3 })],
      [app({ amount: 150.64, date: '2026-06-27', description: '171 - Riachuelo - Sb C Sao Bernardo Bra', installmentNumber: 1, totalInstallments: 3 })],
    );
    assert.equal(r.matched.length, 0);
    assert.equal(r.amountMismatches.length, 1);
    assert.equal(r.amountMismatches[0].diff, 0.01);
    assert.equal(r.missingInApp.length, 0);
    assert.equal(r.onlyInApp.length, 0);
  });

  it('reports statement lines absent from the app (estorno case)', () => {
    const r = reconcileFatura(
      [
        st({ amount: 167.38, date: '2026-06-30', description: 'NIKE PARC01/06', installmentNumber: 1, totalInstallments: 6 }),
        st({ amount: -399.99, date: '2026-06-30', description: 'NIKE' }),
      ],
      [app({ amount: 167.38, date: '2026-06-30', description: 'Nike Parc01/06', installmentNumber: 1, totalInstallments: 6 })],
    );
    assert.equal(r.matched.length, 1);
    assert.equal(r.missingInApp.length, 1);
    assert.equal(r.missingInApp[0].amount, -399.99);
  });

  it('reports app rows absent from the statement', () => {
    const r = reconcileFatura(
      [],
      [app({ amount: 50, date: '2026-07-02', description: 'Duplicada Manual' })],
    );
    assert.equal(r.onlyInApp.length, 1);
  });

  it('ignores payment rows on both sides', () => {
    const r = reconcileFatura(
      [st({ amount: -3565, date: '2026-06-25', description: 'PAGAMENTO DE FATURA' })],
      [app({ amount: -3565, date: '2026-06-25', description: 'Pagamento recebido', source: 'pluggy', category: null })],
    );
    assert.equal(r.matched.length, 0);
    assert.equal(r.missingInApp.length, 0);
    assert.equal(r.onlyInApp.length, 0);
  });

  it('does not cross-match a refund with a charge of the same magnitude', () => {
    const r = reconcileFatura(
      [st({ amount: -29.9, date: '2026-06-27', description: 'MERCADOLIVRE*ORNAMODE' })],
      [app({ amount: 29.9, date: '2026-06-27', description: 'Mercadolivre*ornamode' })],
    );
    assert.equal(r.matched.length, 0);
    assert.equal(r.amountMismatches.length, 0);
    assert.equal(r.missingInApp.length, 1);
    assert.equal(r.onlyInApp.length, 1);
  });

  it('uses cardLast4 to disambiguate equal amounts on the same day', () => {
    const s1 = st({ amount: 100, date: '2026-06-21', description: 'AUTO POSTO NOVA PETRO', cardLast4: '3047' });
    const a1 = app({ amount: 100, date: '2026-06-21', description: 'Posto Shell', cardLast4: '3021' });
    const a2 = app({ amount: 100, date: '2026-06-21', description: 'Auto Posto Nova Petro', cardLast4: '3047' });
    const r = reconcileFatura([s1], [a1, a2]);
    assert.equal(r.matched.length, 1);
    assert.equal(r.matched[0].app.id, a2.id);
  });

  it('reconciles a mixed bill end-to-end', () => {
    const statement = [
      st({ amount: 214.7, date: '2026-07-10', description: 'BASTA' }),
      st({ amount: 35, date: '2026-07-10', description: 'REAL BREAD PRODUTOS DE' }),
      st({ amount: 180, date: '2026-06-28', description: 'PERNAMBUCANAS PARC01/05', installmentNumber: 1, totalInstallments: 5 }),
      st({ amount: 44.99, date: '2026-06-22', description: 'DROGASIL 4057' }),
    ];
    const appRows = [
      app({ amount: 179.98, date: '2026-06-28', description: 'Pernambucanas Sao Bernardo Bra', installmentNumber: 1, totalInstallments: 5 }),
      app({ amount: 44.99, date: '2026-06-22', description: 'Drogasil 4057' }),
      app({ amount: 12.5, date: '2026-07-01', description: 'Linha Fantasma' }),
    ];
    const r = reconcileFatura(statement, appRows);
    assert.equal(r.matched.length, 1); // Drogasil
    assert.equal(r.amountMismatches.length, 1); // Pernambucanas cents
    assert.deepEqual(
      r.missingInApp.map((x) => x.description).sort(),
      ['BASTA', 'REAL BREAD PRODUTOS DE'],
    );
    assert.equal(r.onlyInApp.length, 1); // Linha Fantasma
  });
});

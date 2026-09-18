import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReport,
  isPaymentLine,
  issuerFromAccountName,
  type AppLine,
  type RawReconciliation,
} from './reconcileFatura.js';

const app = (over: Partial<AppLine> & { id: string; amount: number }): AppLine => ({
  date: '2026-08-23',
  description: 'SACOLAO SAUDE',
  cardLast4: '3021',
  installmentNumber: null,
  totalInstallments: null,
  source: 'pluggy',
  category: 'Mercado',
  ...over,
});

type RawLine = RawReconciliation['statementLines'][number];
const line = (over: Partial<RawLine> & { amount: number }): RawLine => ({
  quote: `23/08 SACOLAO SAUDE ${over.amount}`,
  date: '2026-08-23',
  description: 'SACOLAO SAUDE',
  cardLast4: '3021',
  installmentNumber: null,
  totalInstallments: null,
  appRef: null,
  note: null,
  ...over,
});

const raw = (over: Partial<RawReconciliation>): RawReconciliation => ({
  netTotal: { amount: null, label: null, reasoning: '' },
  encargos: null,
  statementLines: [],
  onlyInApp: [],
  ...over,
});

describe('isPaymentLine', () => {
  it('detects both payment phrasings', () => {
    assert.equal(isPaymentLine('PAGAMENTO DE FATURA'), true);
    assert.equal(isPaymentLine('Pagamento recebido'), true);
    assert.equal(isPaymentLine('PAGAMENTO*LOJA FURDUNC'), false);
    assert.equal(isPaymentLine(null), false);
  });
});

describe('buildReport', () => {
  it('splits pairs into matched and amount mismatches by the diff it computes', () => {
    const apps = [app({ id: 'x', amount: 50.73 }), app({ id: 'y', amount: 56.36 })];
    const r = buildReport(
      raw({
        statementLines: [line({ amount: 50.73, appRef: 'A1' }), line({ amount: 56.37, appRef: 'A2' })],
      }),
      apps,
    );
    assert.equal(r.matched.length, 1);
    assert.equal(r.matched[0].app.id, 'x');
    assert.equal(r.amountMismatches.length, 1);
    assert.equal(r.amountMismatches[0].app.id, 'y');
    assert.equal(r.amountMismatches[0].diff, 0.01);
    assert.deepEqual(r.warnings, []);
  });

  it('keeps unpaired lines as missing, with the model note', () => {
    const r = buildReport(
      raw({ statementLines: [line({ amount: 101.96, note: 'Não há SHELLBOX no app.' })] }),
      [],
    );
    assert.equal(r.missingInApp.length, 1);
    assert.equal(r.missingInApp[0].note, 'Não há SHELLBOX no app.');
  });

  it('treats a pair to an unknown ref as missing and warns', () => {
    const r = buildReport(raw({ statementLines: [line({ amount: 10, appRef: 'A9' })] }), [
      app({ id: 'x', amount: 10 }),
    ]);
    assert.equal(r.missingInApp.length, 1);
    assert.equal(r.onlyInApp.length, 1, 'the real app row is still accounted for');
    assert.ok(r.warnings.some((w) => w.includes('A9')));
  });

  it('never pairs one app row twice', () => {
    const r = buildReport(
      raw({
        statementLines: [line({ amount: 1.5, appRef: 'A1' }), line({ amount: 1.5, appRef: 'A1' })],
      }),
      [app({ id: 'x', amount: 1.5 })],
    );
    assert.equal(r.matched.length, 1);
    assert.equal(r.missingInApp.length, 1);
    assert.ok(r.warnings.some((w) => w.includes('já usada')));
  });

  it('carries the model reason for only-in-app rows', () => {
    const r = buildReport(raw({ onlyInApp: [{ appRef: 'A1', reason: 'Duplicata de A2.' }] }), [
      app({ id: 'x', amount: 5 }),
    ]);
    assert.equal(r.onlyInApp[0].id, 'x');
    assert.equal(r.onlyInApp[0].reason, 'Duplicata de A2.');
  });

  it('prefers the pairing when a row is both paired and only-in-app', () => {
    const r = buildReport(
      raw({
        statementLines: [line({ amount: 5, appRef: 'A1' })],
        onlyInApp: [{ appRef: 'A1', reason: 'x' }],
      }),
      [app({ id: 'x', amount: 5 })],
    );
    assert.equal(r.matched.length, 1);
    assert.equal(r.onlyInApp.length, 0);
    assert.equal(r.warnings.length, 1);
  });

  it('lists app rows the model never mentioned as only-in-app, flagged', () => {
    const r = buildReport(raw({}), [app({ id: 'x', amount: 5 }), app({ id: 'y', amount: 6 })]);
    assert.deepEqual(
      r.onlyInApp.map((o) => o.id),
      ['x', 'y'],
    );
    assert.ok(r.warnings.some((w) => w.includes('2 linhas')));
  });

  it('sums the lines itself and warns when they miss the printed total', () => {
    // PicPay setembro/2026: the model picked "Total da fatura" 9.972,58 but
    // also invented a R$ 24,99 line — the sum exposes it.
    const r = buildReport(
      raw({
        netTotal: { amount: 9972.58, label: 'Total da fatura', reasoning: '…' },
        statementLines: [line({ amount: 9987.47 }), line({ amount: -39.9 }), line({ amount: 24.99 })],
      }),
      [],
    );
    assert.equal(r.statementRowsTotal, 9972.56);
    assert.equal(r.statementTotal, 9972.58);
    assert.equal(r.statementTotalLabel, 'Total da fatura');
    assert.ok(r.warnings.some((w) => w.includes('somam')));
  });

  it('does not warn when the lines add up to the printed total', () => {
    const r = buildReport(
      raw({
        netTotal: { amount: 60.1, label: 'Total da fatura', reasoning: '…' },
        statementLines: [line({ amount: 100 }), line({ amount: -39.9 })],
      }),
      [],
    );
    assert.equal(r.statementRowsTotal, 60.1);
    assert.deepEqual(r.warnings, []);
  });
});

describe('issuerFromAccountName', () => {
  it('recognizes the issuer from the product name', () => {
    assert.equal(issuerFromAccountName('PIC PAY MASTERCARD BLACK'), 'picpay');
    assert.equal(issuerFromAccountName('PicPay Card'), 'picpay');
    assert.equal(issuerFromAccountName('LATAM PASS ITAU MASTERCARD PLATINUM'), 'itau');
    assert.equal(issuerFromAccountName('Itaú Uniclass'), 'itau');
  });
  it('returns null for unknown issuers', () => {
    assert.equal(issuerFromAccountName('NUBANK'), null);
    assert.equal(issuerFromAccountName(null), null);
  });
});

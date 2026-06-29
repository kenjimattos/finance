import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExtraction, normalizeBaseUrl } from './extractFatura.js';

describe('normalizeBaseUrl', () => {
  it('strips a trailing /v1 (OpenRouter gateway footgun)', () => {
    assert.equal(normalizeBaseUrl('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api');
  });
  it('strips trailing slashes', () => {
    assert.equal(normalizeBaseUrl('https://openrouter.ai/api/'), 'https://openrouter.ai/api');
    assert.equal(normalizeBaseUrl('https://openrouter.ai/api/v1/'), 'https://openrouter.ai/api');
  });
  it('leaves a clean base untouched', () => {
    assert.equal(normalizeBaseUrl('https://openrouter.ai/api'), 'https://openrouter.ai/api');
    assert.equal(normalizeBaseUrl('https://api.anthropic.com'), 'https://api.anthropic.com');
  });
});

describe('normalizeExtraction', () => {
  it('keeps a plain charge positive', () => {
    const [row] = normalizeExtraction({
      transactions: [
        { date: '2026-06-06', description: 'Anthropic* Claude Sub', amount: 110, isRefund: false, cardLast4: '3047', installmentNumber: null, totalInstallments: null },
      ],
    });
    assert.equal(row.amount, 110);
    assert.equal(row.isRefund, false);
    assert.equal(row.cardLast4, '3047');
  });

  it('makes a refund (estorno) negative', () => {
    const [row] = normalizeExtraction({
      transactions: [
        { date: '2026-06-17', description: 'Shopee*lucas Almeida D', amount: 71.19, isRefund: true, cardLast4: null, installmentNumber: null, totalInstallments: null },
      ],
    });
    assert.equal(row.amount, -71.19);
    assert.equal(row.isRefund, true);
  });

  it('forces magnitude even if the model returns a negative amount', () => {
    const [row] = normalizeExtraction({
      transactions: [
        { date: '2026-06-08', description: 'Dl *aliexpress', amount: -9.63, isRefund: true, cardLast4: '3054', installmentNumber: null, totalInstallments: null },
      ],
    });
    assert.equal(row.amount, -9.63);
  });

  it('parses installment pair', () => {
    const [row] = normalizeExtraction({
      transactions: [
        { date: '2026-06-07', description: 'Amazonmktplc*m', amount: 104.03, isRefund: false, cardLast4: '3054', installmentNumber: 1, totalInstallments: 5 },
      ],
    });
    assert.equal(row.installmentNumber, 1);
    assert.equal(row.totalInstallments, 5);
  });

  it('drops installment metadata when only one side is present', () => {
    const [row] = normalizeExtraction({
      transactions: [
        { date: '2026-06-07', description: 'X', amount: 10, isRefund: false, cardLast4: null, installmentNumber: 2, totalInstallments: null },
      ],
    });
    assert.equal(row.installmentNumber, null);
    assert.equal(row.totalInstallments, null);
  });

  it('clamps installmentNumber that exceeds total', () => {
    const [row] = normalizeExtraction({
      transactions: [
        { date: '2026-06-07', description: 'X', amount: 10, isRefund: false, cardLast4: null, installmentNumber: 5, totalInstallments: 3 },
      ],
    });
    assert.equal(row.installmentNumber, 3);
    assert.equal(row.totalInstallments, 3);
  });

  it('normalizes empty/whitespace card to null and trims description', () => {
    const [row] = normalizeExtraction({
      transactions: [
        { date: '2026-06-06', description: '  Nowigo  ', amount: 2, isRefund: false, cardLast4: '   ', installmentNumber: null, totalInstallments: null },
      ],
    });
    assert.equal(row.cardLast4, null);
    assert.equal(row.description, 'Nowigo');
  });

  it('preserves non-numeric card identifiers, uppercased', () => {
    const [row] = normalizeExtraction({
      transactions: [
        { date: '2026-06-06', description: 'X', amount: 2, isRefund: false, cardLast4: 'digital-picpay', installmentNumber: null, totalInstallments: null },
      ],
    });
    assert.equal(row.cardLast4, 'DIGITAL-PICPAY');
  });

  it('rejects a malformed payload', () => {
    assert.throws(() => normalizeExtraction({ transactions: [{ date: 'nope', description: 'X', amount: 1, isRefund: false, cardLast4: null, installmentNumber: null, totalInstallments: null }] }));
    assert.throws(() => normalizeExtraction({}));
  });

  it('handles an empty transaction list', () => {
    assert.deepEqual(normalizeExtraction({ transactions: [] }), []);
  });
});

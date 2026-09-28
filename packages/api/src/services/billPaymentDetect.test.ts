import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeBillPayment } from './billPaymentDetect.js';

/**
 * Tests for looksLikeBillPayment — the rule the bank sync applies to a newly
 * arrived row to auto-tag it as a credit-card bill payment.
 */

describe('looksLikeBillPayment', () => {
  it('matches "fatura" anywhere, case-insensitive', () => {
    assert.equal(looksLikeBillPayment('Pagamento de fatura', -1200), true);
    assert.equal(looksLikeBillPayment('PAG FATURA CARTAO', -50), true);
  });

  it('matches descriptions starting with "INT "', () => {
    assert.equal(looksLikeBillPayment('INT ITAU UNICLASS', -800), true);
    assert.equal(looksLikeBillPayment('int picpay', -800), true);
  });

  it('does not match "INT" in the middle or without a following space', () => {
    assert.equal(looksLikeBillPayment('PIX INTER', -30), false);
    assert.equal(looksLikeBillPayment('INTERNET FIBRA', -99), false);
  });

  it('ignores inflows, even when the description matches', () => {
    assert.equal(looksLikeBillPayment('Estorno fatura', 40), false);
    assert.equal(looksLikeBillPayment('Pagamento de fatura', 0), false);
  });

  it('returns false for a missing description', () => {
    assert.equal(looksLikeBillPayment(null, -100), false);
  });
});

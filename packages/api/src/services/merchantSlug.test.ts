import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractMerchantSlug } from './merchantSlug.js';

describe('extractMerchantSlug', () => {
  // ─── Processor prefix stripping ──────────────────────────────────

  it('strips PAG* prefix', () => {
    assert.equal(extractMerchantSlug('PAG*UBER'), 'UBER');
  });

  it('strips EC * prefix (with space)', () => {
    assert.equal(extractMerchantSlug('EC *NETFLIX.COM'), 'NETFLIX.COM');
  });

  it('strips DL* prefix', () => {
    assert.equal(extractMerchantSlug('DL*SPOTIFY'), 'SPOTIFY');
  });

  it('strips MP* prefix', () => {
    assert.equal(extractMerchantSlug('MP*MERCADOLIVRE'), 'MERCADOLIVRE');
  });

  it('strips PAGSEGURO* prefix', () => {
    assert.equal(extractMerchantSlug('PAGSEGURO*LOJA XYZ'), 'LOJA XYZ');
  });

  // ─── Star / dash splitting ───────────────────────────────────────

  it('preserves meaningful token after * (>= 3 alpha chars)', () => {
    assert.equal(extractMerchantSlug('IFOOD *RESTAURANTE XYZ'), 'IFOOD RESTAURANTE');
  });

  it('takes text before " - " as merchant', () => {
    assert.equal(extractMerchantSlug('AMAZON - SAO PAULO BR'), 'AMAZON');
  });

  it('handles prefix + star together', () => {
    assert.equal(extractMerchantSlug('PAG*JoeSmith*1234'), 'JOESMITH');
  });

  // ─── Location stripping ──────────────────────────────────────────

  it('strips trailing BR', () => {
    assert.equal(extractMerchantSlug('UBER TRIP BR'), 'UBER TRIP');
  });

  it('strips trailing SAO PAULO', () => {
    assert.equal(extractMerchantSlug('LOJA TESTE SAO PAULO'), 'LOJA TESTE');
  });

  // ─── Token limiting (max 3) ──────────────────────────────────────

  it('keeps at most 3 tokens', () => {
    assert.equal(
      extractMerchantSlug('ONE TWO THREE FOUR FIVE'),
      'ONE TWO THREE',
    );
  });

  // ─── Fuzzy collapsing ────────────────────────────────────────────

  it('collapses IFOOD variants to same slug (qualifier preserved)', () => {
    const a = extractMerchantSlug('IFOOD *RESTAURANTE A');
    const b = extractMerchantSlug('IFOOD *RESTAURANTE B');
    assert.equal(a, b);
    assert.equal(a, 'IFOOD RESTAURANTE');
  });

  it('differentiates UBER EATS from UBER TRIP', () => {
    const trip = extractMerchantSlug('UBER   *TRIP BR');
    const eats = extractMerchantSlug('UBER *EATS BR');
    assert.notEqual(trip, eats);
    assert.equal(trip, 'UBER TRIP');
    assert.equal(eats, 'UBER EATS');
  });

  it('drops short token after * (< 3 chars)', () => {
    assert.equal(extractMerchantSlug('IFOOD *A'), 'IFOOD');
    assert.equal(extractMerchantSlug('IFOOD *AB'), 'IFOOD');
  });

  // ─── Edge cases ──────────────────────────────────────────────────

  it('returns null for null/undefined/empty', () => {
    assert.equal(extractMerchantSlug(null), null);
    assert.equal(extractMerchantSlug(undefined), null);
    assert.equal(extractMerchantSlug(''), null);
    assert.equal(extractMerchantSlug('   '), null);
  });

  it('rejects purely numeric slugs', () => {
    assert.equal(extractMerchantSlug('12345'), null);
  });

  it('rejects slugs shorter than 2 chars', () => {
    assert.equal(extractMerchantSlug('A'), null);
  });

  it('preserves dots in domain-like names', () => {
    assert.equal(extractMerchantSlug('AMAZON.COM.BR'), 'AMAZON.COM.BR');
  });

  it('handles MERCADO LIVRE*ML pattern', () => {
    assert.equal(extractMerchantSlug('MERCADO LIVRE*ML'), 'MERCADO LIVRE');
  });
});

import { randomUUID, createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { extractMerchantSlug } from './merchantSlug.js';
import { recomputeShiftForDateChange } from './billWindow.js';

/**
 * The credit-card transaction upsert engine — the most dangerous decision
 * logic in the codebase, extracted from routes/transactions.ts so every
 * branch can be unit-tested against real Pluggy payloads (including the
 * corrupted ones from the 2026-07 PicPay incident, preserved as fixtures
 * in syncCreditTransactions.test.ts).
 *
 * The engine runs two passes over the account's complete served set.
 *
 * Pass 1 — payloads whose provider ID is already known:
 *
 *   1. provider ID known, identity hash matches (or stored hash is NULL)
 *      → update mutable fields only
 *   2. provider ID known, hash differs, but same amount + same merchant
 *      slug → "repost": Pluggy replaced the purchase date with the posting
 *      date; move the date in place and recompute any bill-shift override
 *   3. provider ID known, materially different content → recycled ID:
 *      keep the old row, mint a new one, log to transaction_sync_conflicts
 *
 * Pass 2 — payloads whose provider ID is unknown, run only after pass 1 so
 * the set of IDs served in this sync is complete:
 *
 *   4. the content hash matches a pluggy row whose provider ID was NOT
 *      served in this sync (an orphan) → the same purchase re-served under
 *      a new ID (reconnect, PicPay's daily ID rotation): adopt the new ID
 *   5. a POSTED payload matching exactly one orphan PENDING row (same
 *      amount + merchant slug, instants within PENDING_POSTED_MAX_HOURS) →
 *      the issuer posted the purchase under a new ID (Itaú): promote the
 *      PENDING row in place, so user work stays attached
 *   6. otherwise → insert a brand-new row. A hash match against a row that
 *      WAS served is a genuinely distinct purchase with identical content —
 *      Pluggy returning both records side by side is the proof
 *
 * Full state machine documentation: docs/sync.md.
 */

/**
 * Structural subset of pluggy-sdk's Transaction that the engine reads.
 * Declared locally (instead of importing the SDK type) so tests can build
 * payloads as plain objects and the engine stays decoupled from SDK
 * version bumps. The full payload object is serialized into raw_json.
 */
export interface IncomingCreditTransaction {
  id: string;
  description?: string | null;
  descriptionRaw?: string | null;
  amount: number;
  amountInAccountCurrency?: number | null;
  currencyCode?: string | null;
  date: Date | string;
  category?: string | null;
  categoryId?: string | null;
  type?: string | null;
  status?: string | null;
  creditCardMetadata?: {
    installmentNumber?: number | null;
    totalInstallments?: number | null;
    billId?: string | null;
    cardNumber?: string | null;
  } | null;
}

export interface UpsertCounts {
  processed: number;
  inserted: number;
  updated: number;
  reposts: number;
  recycled: number;
  /** Corrupted in-place mutations absorbed without minting a row. */
  suppressed: number;
  /** Orphan PENDING rows promoted by their POSTED successor under a new ID. */
  pendingPosted: number;
}

/**
 * A repost (same provider ID + amount + merchant slug, new date) is only
 * plausible within this many days — real PENDING→POSTED transitions settle
 * in days, not months. Beyond it, the "new date" is Pluggy re-dating a stale
 * record (observed on PicPay: April ghosts re-dated to July), and moving the
 * row would drag old categorized spend into the open bill.
 */
export const REPOST_MAX_DAYS = 45;

/**
 * How far apart the PENDING and POSTED instants of one purchase may be when
 * the issuer re-mints the ID on posting. Itaú shifts the time by exactly
 * -3h (observed on every prod pair); the slack covers the calendar day
 * flipping at midnight and issuers that stamp the posting time instead.
 */
export const PENDING_POSTED_MAX_HOURS = 72;

interface ExistingRow {
  id: string;
  identity_hash: string | null;
  raw_json: string;
  date: string;
  amount: number;
  description: string | null;
}

/**
 * Upsert everything Pluggy served for one account in one sync, inside a
 * single SQLite transaction. Returns per-outcome counts.
 *
 * `txs` must be the account's COMPLETE result set (all pages), not a page:
 * each call is recorded as one sync run, and every payload is logged to
 * transaction_payloads against that run.
 */
export function upsertCreditTransactions(
  db: Database,
  txs: IncomingCreditTransaction[],
  accountId: string,
  itemId: string,
): UpsertCounts {
  // INSERT for a transaction that doesn't exist yet (or a recycled-ID new row).
  const insertTx = db.prepare(`
    INSERT INTO transactions
      (id, provider_transaction_id, account_id, item_id, date, description, amount,
       amount_in_account_currency, currency_code, pluggy_category, pluggy_category_id,
       type, status, installment_number, total_installments, bill_id, card_last4,
       identity_hash, raw_json, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  // UPDATE only the mutable fields on a known-good existing row.
  // We deliberately do NOT update identity-stable fields (date, amount, description,
  // card_last4, installment_*) so that user-applied overrides remain attached
  // to the correct transaction even if Pluggy tweaks peripheral fields.
  const updateTx = db.prepare(`
    UPDATE transactions SET
      status        = ?,
      bill_id       = ?,
      identity_hash = ?,
      last_seen_at  = datetime('now'),
      raw_json      = ?,
      synced_at     = datetime('now')
    WHERE id = ?
  `);

  // All rows sharing a Pluggy ID, newest first (recycles leave siblings).
  // The full list lets the engine match an incoming payload against ANY
  // generation — if Pluggy flip-flops a record back to a previous content,
  // we update that sibling instead of minting an endless chain of copies.
  const findByProviderId = db.prepare(`
    SELECT id, identity_hash, raw_json, date, amount, description
    FROM transactions
    WHERE provider_transaction_id = ?
    ORDER BY first_seen_at DESC, rowid DESC
  `);

  // Minimal touch for suppressed mutations: record that Pluggy still serves
  // this provider ID (and what it claims now) WITHOUT absorbing the mutated
  // content into the row's identity or display fields.
  const touchTx = db.prepare(`
    UPDATE transactions SET
      last_seen_at = datetime('now'),
      raw_json     = ?,
      synced_at    = datetime('now')
    WHERE id = ?
  `);

  // Used when a transaction transitions PENDING → POSTED and Pluggy adjusts
  // the date (the original purchase date is replaced by the posting date).
  // Same provider_id + same amount + same merchant slug = same purchase, so
  // we update the date along with the mutable fields. User-applied overrides
  // (categorization, splits, bill shifts) stay attached to the same row.
  const updateTxRepost = db.prepare(`
    UPDATE transactions SET
      date          = ?,
      status        = ?,
      bill_id       = ?,
      identity_hash = ?,
      last_seen_at  = datetime('now'),
      raw_json      = ?,
      synced_at     = datetime('now')
    WHERE id = ?
  `);

  // Pass-2 lookup by content hash — used when provider_transaction_id is
  // not found (reconnects, where Pluggy issues new IDs for the same physical
  // card; PicPay re-minting IDs per scrape). Matches only pluggy-sourced
  // rows to avoid colliding with manual transactions. Returns every
  // candidate; the caller keeps only orphans.
  const findByIdentityHash = db.prepare(`
    SELECT id, provider_transaction_id
    FROM transactions
    WHERE identity_hash = ?
      AND source = 'pluggy'
    ORDER BY first_seen_at DESC, rowid DESC
  `);

  // Like updateTx but also records the new provider_transaction_id.
  // Used when a reconnect brings new Pluggy IDs for an existing transaction.
  const updateTxWithProvider = db.prepare(`
    UPDATE transactions SET
      provider_transaction_id = ?,
      status        = ?,
      bill_id       = ?,
      identity_hash = ?,
      last_seen_at  = datetime('now'),
      raw_json      = ?,
      synced_at     = datetime('now')
    WHERE id = ?
  `);

  // Bill shifts are relative to the transaction's date, so a repost that moves
  // the date invalidates the stored shift (it would drag the row to a
  // neighboring bill). These support recomputing it against the new date.
  const getShiftOverride = db.prepare(
    `SELECT shift FROM transaction_bill_overrides WHERE transaction_id = ?`,
  );
  const setShiftOverride = db.prepare(
    `UPDATE transaction_bill_overrides SET shift = ? WHERE transaction_id = ?`,
  );
  const deleteShiftOverride = db.prepare(
    `DELETE FROM transaction_bill_overrides WHERE transaction_id = ?`,
  );
  const getAccountSettings = db.prepare(
    `SELECT closing_day, due_day FROM account_settings WHERE account_id = ?`,
  );

  // Pass-2 candidates for a POSTED payload under a new ID: this account's
  // PENDING rows with the same amount. Slug, orphan status and time window
  // are checked in JS.
  const findPendingByAmount = db.prepare(`
    SELECT id, provider_transaction_id, date, description, raw_json
    FROM transactions
    WHERE account_id = ?
      AND source = 'pluggy'
      AND status = 'PENDING'
      AND amount = ?
  `);

  // Promote a PENDING row to its POSTED successor: the row takes the new
  // provider ID and every field the posting legitimately changes. Identity
  // display fields (description, amount, card) stay, like in a repost.
  const promotePending = db.prepare(`
    UPDATE transactions SET
      provider_transaction_id = ?,
      date          = ?,
      status        = ?,
      bill_id       = ?,
      identity_hash = ?,
      last_seen_at  = datetime('now'),
      raw_json      = ?,
      synced_at     = datetime('now')
    WHERE id = ?
  `);

  const insertConflict = db.prepare(`
    INSERT INTO transaction_sync_conflicts
      (provider_transaction_id, kept_transaction_id, new_transaction_id,
       kind, old_payload_json, new_payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertSyncRun = db.prepare(
    `INSERT INTO sync_runs (account_id, served_count) VALUES (?, ?)`,
  );
  const finishSyncRun = db.prepare(`UPDATE sync_runs SET counts_json = ? WHERE id = ?`);

  // Observation log (see the table comment in db/index.ts). An unchanged
  // payload only advances last_seen; the local row it landed on is refreshed
  // because adoption can move a provider ID onto a different row.
  const logPayload = db.prepare(`
    INSERT INTO transaction_payloads
      (account_id, provider_transaction_id, transaction_id, payload_hash, raw_json,
       first_sync_run_id, last_sync_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider_transaction_id, payload_hash) DO UPDATE SET
      transaction_id   = excluded.transaction_id,
      last_seen_at     = datetime('now'),
      last_sync_run_id = excluded.last_sync_run_id
  `);

  // Bill shifts are relative to the transaction's date, so moving a row's
  // date (repost, PENDING promotion) invalidates the stored shift — it
  // would drag the row to a neighboring bill. Recompute it so the row keeps
  // displaying on the bill the user placed it on. Typical case: a pending
  // Itaú installment dated on the bill's due date, shifted -1 to land on the
  // right bill — once it posts with the real date it falls on that bill
  // naturally and the shift must go.
  const realignShift = (rowId: string, oldDate: string, newDate: string, providerId: string) => {
    if (oldDate === newDate) return;
    const override = getShiftOverride.get(rowId) as { shift: number } | undefined;
    if (!override || override.shift === 0) return;
    const settings = getAccountSettings.get(accountId) as
      | { closing_day: number; due_day: number }
      | undefined;
    if (!settings) return;
    const newShift = recomputeShiftForDateChange(
      { closingDay: settings.closing_day, dueDay: settings.due_day },
      oldDate,
      newDate,
      override.shift,
    );
    if (newShift === null || Math.abs(newShift) > 1) {
      // Can't place the row on the original target bill with a ±1 shift —
      // its natural cycle (usually the true bill after a repost) is the
      // least wrong option.
      console.warn(
        `[sync] ${providerId} moved ${oldDate} → ${newDate} across ` +
        `multiple cycles (required shift ${newShift}); clearing stale shift ${override.shift}.`,
      );
      deleteShiftOverride.run(rowId);
    } else if (newShift === 0) {
      deleteShiftOverride.run(rowId);
    } else if (newShift !== override.shift) {
      setShiftOverride.run(newShift, rowId);
    }
  };

  const counts: UpsertCounts = {
    processed: 0,
    inserted: 0,
    updated: 0,
    reposts: 0,
    recycled: 0,
    suppressed: 0,
    pendingPosted: 0,
  };

  const runBatch = db.transaction(() => {
    const syncRunId = Number(insertSyncRun.run(accountId, txs.length).lastInsertRowid);
    // Every provider ID Pluggy served for this account in this sync. A row
    // whose provider ID is absent is an orphan: Pluggy stopped serving it.
    const servedIds = new Set(txs.map((t) => t.id));
    const unknownIds: IncomingCreditTransaction[] = [];

    const record = (t: IncomingCreditTransaction, rawJson: string, appliedTo: string) =>
      logPayload.run(accountId, t.id, appliedTo, payloadHash(rawJson), rawJson, syncRunId, syncRunId);

    // ── Pass 1: known provider IDs ────────────────────────────────────────
    for (const t of txs) {
      const siblings = findByProviderId.all(t.id) as ExistingRow[];
      const existing: ExistingRow | undefined = siblings[0];
      if (!existing) {
        unknownIds.push(t);
        continue;
      }

      const metadata = t.creditCardMetadata ?? null;
      const newDate = toYmd(t.date);
      const newPayload = JSON.stringify(t);
      const newHash = computeIdentityHash(toInstant(t.date), t.amount, t.description ?? null);
      // The local row this payload ends up on, for the observation log.
      let appliedTo: string;

      // Absorb a corrupted or implausible in-place mutation: keep the row's
      // identity and display fields untouched, refresh raw_json/last_seen so
      // the anomaly is visible but doesn't repeat, and log it once (repeat
      // deliveries of the same payload produce no new conflict rows).
      const suppressMutation = (row: ExistingRow, why: string): string => {
        if (row.raw_json !== newPayload) {
          console.warn(`[sync] Suppressed in-place mutation of ${t.id} (${why}).`);
          insertConflict.run(t.id, row.id, null, 'mutation-suppressed', row.raw_json, newPayload);
        }
        touchTx.run(newPayload, row.id);
        counts.suppressed++;
        return row.id;
      };

      // Match the payload against ANY sibling generation, not just the
      // newest: if Pluggy reverts a mutated record to a previous content,
      // the row for that content already exists and just gets refreshed —
      // without this, every flip-flop would mint another copy.
      const hashMatch =
        existing.identity_hash === null
          ? existing // pre-migration row: first sync backfills the hash
          : siblings.find((s) => s.identity_hash === newHash);

      if (hashMatch) {
        // Same transaction — only update fields that Pluggy legitimately
        // changes over time.
        updateTx.run(t.status ?? null, metadata?.billId ?? null, newHash, newPayload, hashMatch.id);
        appliedTo = hashMatch.id;
        counts.updated++;
      } else if (isChimeraMutation(t, existing)) {
        // Corrupted half-mutation (2026-07 PicPay incident): Pluggy rewrote
        // description/date/MCC of an existing record but descriptionRaw and
        // amount still belong to the OLD content. The payload is a chimera —
        // a real merchant name grafted onto a stale record's amount — and
        // minting it would put a phantom on the bill.
        appliedTo = suppressMutation(existing, 'chimera: descriptionRaw/amount still match the old record');
      } else if (
        existing.amount === t.amount &&
        extractMerchantSlug(existing.description) === extractMerchantSlug(t.description ?? null) &&
        daysBetween(existing.date, newDate) > REPOST_MAX_DAYS
      ) {
        // Same content but the date jumped implausibly far: this is not a
        // PENDING→POSTED repost, it's Pluggy re-dating a stale record. Moving
        // the row would drag old (often categorized) spend into the current
        // bill, so absorb the mutation instead.
        appliedTo = suppressMutation(
          existing,
          `date jump ${existing.date} → ${newDate} exceeds ${REPOST_MAX_DAYS} days`,
        );
      } else if (
        existing.amount === t.amount &&
        extractMerchantSlug(existing.description) === extractMerchantSlug(t.description ?? null)
      ) {
        // Same provider_id + same amount + same merchant slug, but date changed:
        // this is a PENDING→POSTED transition where Pluggy replaces the original
        // purchase date with the posting date. Update in place (including date)
        // so user work stays attached to the same row.
        console.log(
          `[sync] Repost detected for ${t.id}: ${existing.date} → ${newDate} ` +
          `(status ${t.status ?? '?'}). Updating in place.`,
        );
        updateTxRepost.run(newDate, t.status ?? null, metadata?.billId ?? null, newHash, newPayload, existing.id);
        appliedTo = existing.id;
        counts.reposts++;
        realignShift(existing.id, existing.date, newDate, t.id);
      } else {
        // Recycled Pluggy ID: the incoming payload is a materially different
        // purchase. Keep the old row intact and insert the new one separately.
        const newLocalId = randomUUID();
        console.warn(
          `[sync] Recycled provider ID ${t.id}: existing identity ${existing.identity_hash} ` +
          `≠ incoming ${newHash}. Keeping old row, inserting new (${newLocalId}).`,
        );
        insertTx.run(
          newLocalId, t.id, accountId, itemId, newDate,
          t.description ?? null, t.amount,
          t.amountInAccountCurrency ?? null, t.currencyCode ?? null,
          t.category ?? null, t.categoryId ?? null, t.type ?? null, t.status ?? null,
          metadata?.installmentNumber ?? null, metadata?.totalInstallments ?? null,
          metadata?.billId ?? null, lastFourDigits(metadata?.cardNumber),
          newHash, newPayload,
        );
        insertConflict.run(t.id, existing.id, newLocalId, 'recycled', existing.raw_json, newPayload);
        appliedTo = newLocalId;
        counts.recycled++;
      }
      record(t, newPayload, appliedTo);
      counts.processed++;
    }

    // ── Pass 2: unknown provider IDs ──────────────────────────────────────
    for (const t of unknownIds) {
      const metadata = t.creditCardMetadata ?? null;
      const newDate = toYmd(t.date);
      const newPayload = JSON.stringify(t);
      const newHash = computeIdentityHash(toInstant(t.date), t.amount, t.description ?? null);
      let appliedTo: string;

      // Same content under a new ID only counts as the same purchase when
      // the old ID stopped being served. If Pluggy still serves the old
      // record alongside this one, they are two purchases with identical
      // content (seen in prod: two metro taps, or Itaú's older records that
      // all carry the same synthetic 18:00:01 time) and both must stay.
      const orphan = (findByIdentityHash.all(newHash) as Array<{
        id: string;
        provider_transaction_id: string | null;
      }>).find((r) => r.provider_transaction_id === null || !servedIds.has(r.provider_transaction_id));

      // PENDING→POSTED under a new ID (Itaú): the POSTED keeps amount and
      // merchant but carries a new provider ID and a shifted time, so its
      // hash never matches the PENDING's. The PENDING row must be an orphan
      // too — if Pluggy still serves it, the two are separate records.
      const pendingMatches =
        orphan || t.status !== 'POSTED'
          ? []
          : (findPendingByAmount.all(accountId, t.amount) as Array<{
              id: string;
              provider_transaction_id: string | null;
              date: string;
              description: string | null;
              raw_json: string;
            }>).filter(
              (p) =>
                (p.provider_transaction_id === null || !servedIds.has(p.provider_transaction_id)) &&
                extractMerchantSlug(p.description) === extractMerchantSlug(t.description ?? null) &&
                hoursBetween(storedIdentityInstant(p.date, p.raw_json), toInstant(t.date)) <=
                  PENDING_POSTED_MAX_HOURS,
            );

      if (orphan) {
        console.log(`[sync] Hash match for new provider ID ${t.id} — adopting orphan row ${orphan.id}`);
        updateTxWithProvider.run(t.id, t.status ?? null, metadata?.billId ?? null, newHash, newPayload, orphan.id);
        appliedTo = orphan.id;
        counts.updated++;
      } else if (pendingMatches.length === 1) {
        const pending = pendingMatches[0];
        console.log(
          `[sync] POSTED ${t.id} succeeds orphan PENDING row ${pending.id} ` +
          `(${pending.provider_transaction_id}); promoting in place.`,
        );
        promotePending.run(t.id, newDate, t.status ?? null, metadata?.billId ?? null, newHash, newPayload, pending.id);
        realignShift(pending.id, pending.date, newDate, t.id);
        appliedTo = pending.id;
        counts.pendingPosted++;
      } else {
        appliedTo = randomUUID();
        insertTx.run(
          appliedTo, t.id, accountId, itemId, newDate,
          t.description ?? null, t.amount,
          t.amountInAccountCurrency ?? null, t.currencyCode ?? null,
          t.category ?? null, t.categoryId ?? null, t.type ?? null, t.status ?? null,
          metadata?.installmentNumber ?? null, metadata?.totalInstallments ?? null,
          metadata?.billId ?? null, lastFourDigits(metadata?.cardNumber),
          newHash, newPayload,
        );
        counts.inserted++;
        if (pendingMatches.length > 1) {
          // Several orphan PENDINGs fit: guessing would move user work onto
          // the wrong purchase. Insert, and log a conflict so the row skips
          // learned rules and lands in the inbox for a human.
          console.warn(
            `[sync] POSTED ${t.id} fits ${pendingMatches.length} orphan PENDING rows; ` +
            `inserting ${appliedTo} for review.`,
          );
          insertConflict.run(
            t.id, pendingMatches[0].id, appliedTo, 'pending-posted-ambiguous',
            pendingMatches[0].raw_json, newPayload,
          );
        }
      }
      record(t, newPayload, appliedTo);
      counts.processed++;
    }

    finishSyncRun.run(JSON.stringify(counts), syncRunId);
  });
  runBatch();

  return counts;
}

/**
 * Detect the corrupted half-mutation pattern observed on the PicPay
 * connector (2026-07): Pluggy rewrites `description`, `date` and MCC of an
 * existing record, but `descriptionRaw` and `amount` still carry the OLD
 * content. A payload whose raw description matches the stored row while its
 * display description points at a different merchant — with the amount
 * unchanged — is internally inconsistent and must not become a transaction.
 *
 * Conservative on purpose: if descriptionRaw is absent, or raw and display
 * descriptions agree, this never fires (a real recycled ID carries a
 * consistent payload where descriptionRaw matches the new description).
 */
function isChimeraMutation(
  t: IncomingCreditTransaction,
  existing: { amount: number; description: string | null },
): boolean {
  if (t.descriptionRaw == null) return false;
  const rawSlug = extractMerchantSlug(t.descriptionRaw);
  if (rawSlug === null) return false;
  return (
    t.amount === existing.amount &&
    rawSlug === extractMerchantSlug(existing.description) &&
    rawSlug !== extractMerchantSlug(t.description ?? null)
  );
}

/** Content fingerprint of a raw payload, for the observation log. */
function payloadHash(rawJson: string): string {
  return createHash('sha256').update(rawJson).digest('hex').slice(0, 32);
}

/** Hours between two ISO instants (absolute). */
function hoursBetween(a: string, b: string): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 3_600_000;
}

/** Whole days between two yyyy-mm-dd strings (absolute, UTC). */
function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/**
 * Stable fingerprint for a transaction: SHA-256 of the full payload instant
 * (ISO, millisecond precision) + amount + merchant slug. Used by sync to
 * detect Pluggy ID recycling AND to deduplicate across reconnects (same
 * purchase, different Pluggy connection = new provider IDs but same content
 * hash).
 *
 * The instant, not just the day, is what separates two real purchases of the
 * same amount at the same merchant on the same day — they differ in
 * time-of-day, while a re-served record keeps the instant to the millisecond.
 *
 * Account ID is intentionally excluded so the hash is portable across
 * reconnections where Pluggy assigns new account IDs for the same physical card.
 */
export function computeIdentityHash(
  instant: string,
  amount: number,
  description: string | null,
): string {
  const slug = extractMerchantSlug(description) ?? '';
  return createHash('sha256')
    .update(`${instant}|${amount}|${slug}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Normalize a payload date to the ISO instant the identity hash uses. Pluggy
 * delivers a Date or an ISO string; unparseable strings pass through as-is
 * so the hash stays deterministic.
 */
export function toInstant(d: Date | string): string {
  const ms = typeof d === 'string' ? Date.parse(d) : d.getTime();
  return Number.isNaN(ms) ? String(d) : new Date(ms).toISOString();
}

/**
 * The instant to hash for an already-stored row: the time-of-day from its
 * raw payload, but only when that payload still describes the row's own
 * date. Suppressed mutations leave a foreign payload in raw_json (a stale
 * record re-dated months away) and must not rewrite the row's identity, so
 * those — and rows without a timestamp, like the demo seed — fall back to
 * midnight UTC of the stored date.
 */
export function storedIdentityInstant(date: string, rawJson: string): string {
  try {
    const raw = (JSON.parse(rawJson) as { date?: unknown }).date;
    if (typeof raw === 'string' && raw.slice(0, 10) === date) return toInstant(raw);
  } catch {
    // fall through
  }
  return `${date}T00:00:00.000Z`;
}

/**
 * Normalize the cardNumber field from creditCardMetadata into a stable
 * identifier for grouping transactions by physical/virtual card.
 *
 * Pluggy connectors return this field in inconsistent shapes:
 *   - "1234"                       → numeric last-4
 *   - "****1234"                   → masked with last-4
 *   - "1234 **** **** 5678"        → full masked PAN
 *   - "DIGITAL-PICPAY"             → non-numeric identifier for virtual cards
 *   - null / undefined / ""        → no card info (internal entries like
 *                                    "pagamento de fatura")
 *
 * Rules:
 *   1. null/empty → null (no card association possible)
 *   2. Contains ≥4 digits → extract last 4 digits (covers most physical cards)
 *   3. Non-numeric string (like "DIGITAL-PICPAY") → keep as-is, uppercased
 *      and trimmed, so it surfaces as a distinct "card" the user can assign
 *      to a group in the card manager
 */
export function lastFourDigits(raw: string | undefined | null): string | null {
  if (!raw || raw.trim() === '') return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 4) return digits.slice(-4);
  // Non-numeric identifier (virtual card, digital wallet, etc.)
  return raw.trim().toUpperCase();
}

/**
 * Pluggy's Transaction.date is a Date object — we normalize it to yyyy-mm-dd
 * at the storage boundary so every downstream comparison (billWindow ranges,
 * UI date pills, etc.) can use plain string math.
 */
export function toYmd(d: Date | string): string {
  if (typeof d === 'string') {
    // Pluggy sometimes returns date as string already; take the first 10 chars.
    return d.slice(0, 10);
  }
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

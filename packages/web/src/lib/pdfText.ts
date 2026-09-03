/**
 * Statement PDF → plain text, in the browser.
 *
 * The reconcile endpoint only ever sees text (the LLM never gets a PDF), so
 * where the bytes are parsed is a privacy choice, not a cost one. Doing it here
 * means a password-protected statement — Brazilian issuers commonly key them on
 * the holder's CPF or birth date — is unlocked locally: the password never
 * leaves the machine and never touches the API, its logs, or the LLM gateway.
 *
 * `unpdf` bundles a worker-less PDF.js build (~1.6MB), so it is imported
 * dynamically: nobody pays for it until they actually reconcile a bill.
 */

/** Mirrors the API's own guard in routes/faturaImport.ts. */
const MIN_TEXT_LENGTH = 100;

/** PDF.js `PasswordResponses`, inlined so the enum isn't worth a static import. */
const NEED_PASSWORD = 1;
const INCORRECT_PASSWORD = 2;

export type PdfErrorKind =
  /** Encrypted, and no password was supplied. */
  | 'NEEDS_PASSWORD'
  /** Encrypted, and the supplied password was rejected. */
  | 'WRONG_PASSWORD'
  /** Parsed fine but has no text layer — a scan. */
  | 'NO_TEXT'
  /** Corrupt, truncated, or not a PDF at all. */
  | 'UNREADABLE';

export class PdfError extends Error {
  constructor(readonly kind: PdfErrorKind) {
    super(kind);
    this.name = 'PdfError';
  }
}

function passwordErrorKind(err: unknown): PdfErrorKind | null {
  if (typeof err !== 'object' || err === null) return null;
  const { name, code } = err as { name?: unknown; code?: unknown };
  if (name !== 'PasswordException') return null;
  if (code === INCORRECT_PASSWORD) return 'WRONG_PASSWORD';
  if (code === NEED_PASSWORD) return 'NEEDS_PASSWORD';
  return 'UNREADABLE';
}

/**
 * Read `file` and return its text. Throws `PdfError` for every failure the UI
 * has something useful to say about.
 *
 * Re-reads the file on each call by design: PDF.js may detach the buffer it is
 * handed, so the retry after a password prompt needs fresh bytes.
 */
export async function extractPdfText(file: File, password?: string): Promise<string> {
  const { getDocumentProxy, extractText } = await import('unpdf');
  const bytes = new Uint8Array(await file.arrayBuffer());

  let doc;
  try {
    doc = await getDocumentProxy(bytes, password ? { password } : {});
  } catch (err) {
    throw new PdfError(passwordErrorKind(err) ?? 'UNREADABLE');
  }

  try {
    const { text } = await extractText(doc, { mergePages: true });
    if (text.trim().length < MIN_TEXT_LENGTH) throw new PdfError('NO_TEXT');
    return text;
  } finally {
    // `getDocumentProxy` hands back the document, not the loading task, so
    // there is no `destroy()` to call — `cleanup()` is what releases the
    // per-page caches a multi-page statement builds up.
    void doc.cleanup();
  }
}

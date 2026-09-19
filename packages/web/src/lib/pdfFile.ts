/**
 * Statement PDF → base64 for the reconcile endpoint, prepared in the browser.
 *
 * The model reads the PDF itself, so nothing is parsed for content here. What
 * happens here is what must not happen on the server: a password-protected
 * statement (Brazilian issuers often key them on the holder's CPF or birth
 * date) is decrypted locally with the password the user types, and only the
 * decrypted copy is uploaded — the password never leaves the machine.
 *
 * The decryption library (`@cantoo/pdf-lib`) is imported dynamically, so only
 * users who reconcile a protected statement download it.
 */

/** 10MB of PDF stays inside the API's 25mb JSON limit once base64-encoded. */
export const MAX_PDF_BYTES = 10 * 1024 * 1024;

export type PdfErrorKind =
  /** Encrypted, and no password was supplied. */
  | 'NEEDS_PASSWORD'
  /** Encrypted, and the supplied password was rejected. */
  | 'WRONG_PASSWORD'
  /** Encrypted with something the library can't open. */
  | 'UNDECRYPTABLE'
  /** Doesn't start with the %PDF- header. */
  | 'NOT_PDF'
  | 'TOO_LARGE';

export class PdfError extends Error {
  constructor(readonly kind: PdfErrorKind) {
    super(kind);
    this.name = 'PdfError';
  }
}

const latin1 = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes);

/**
 * Encrypted PDFs reference an `/Encrypt` dictionary from their trailer (or,
 * in PDF 1.5+, from the xref stream's dictionary, which is never compressed),
 * so the token is always visible in the raw bytes.
 */
function isEncrypted(bytes: Uint8Array): boolean {
  return latin1(bytes).includes('/Encrypt');
}

async function decrypt(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  let src;
  try {
    src = await PDFDocument.load(bytes, { password });
  } catch (err) {
    if (err instanceof Error && /password incorrect/i.test(err.message)) {
      throw new PdfError('WRONG_PASSWORD');
    }
    throw new PdfError('UNDECRYPTABLE');
  }
  // Copy the pages into a fresh document rather than re-saving the source:
  // only objects the pages reach come along. Re-saving carries the source's
  // encryption dictionary and cross-reference stream over verbatim, still
  // pointing at /Encrypt, and the copy would then read as encrypted again.
  const out = await PDFDocument.create();
  for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
  const plain = await out.save();
  if (isEncrypted(plain)) throw new PdfError('UNDECRYPTABLE');
  return plain;
}

function toBase64(bytes: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
  });
}

/**
 * Validate `file`, decrypt it with `password` when it is protected, and
 * return it base64-encoded (no data: prefix). Throws `PdfError`.
 */
export async function readPdfForUpload(file: File, password?: string): Promise<string> {
  if (file.size > MAX_PDF_BYTES) throw new PdfError('TOO_LARGE');
  let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
  if (latin1(bytes.subarray(0, 5)) !== '%PDF-') throw new PdfError('NOT_PDF');
  if (isEncrypted(bytes)) {
    if (!password) throw new PdfError('NEEDS_PASSWORD');
    bytes = await decrypt(bytes, password);
    if (bytes.byteLength > MAX_PDF_BYTES) throw new PdfError('TOO_LARGE');
  }
  return toBase64(bytes);
}

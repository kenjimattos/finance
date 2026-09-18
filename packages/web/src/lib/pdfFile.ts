/**
 * Statement PDF → base64 for the reconcile endpoint, checked in the browser.
 *
 * The model reads the PDF itself, so nothing is parsed here. What is checked
 * is what the server cannot fix: an encrypted statement (Brazilian issuers
 * often key them on the holder's CPF or birth date) would need its password
 * sent along to be read, and the password must not leave the machine — so it
 * is refused here, before any upload, with a message saying why.
 */

/** 10MB of PDF stays inside the API's 25mb JSON limit once base64-encoded. */
export const MAX_PDF_BYTES = 10 * 1024 * 1024;

export type PdfErrorKind =
  /** Password-protected: the PDF has an encryption dictionary. */
  | 'ENCRYPTED'
  /** Doesn't start with the %PDF- header. */
  | 'NOT_PDF'
  | 'TOO_LARGE';

export class PdfError extends Error {
  constructor(readonly kind: PdfErrorKind) {
    super(kind);
    this.name = 'PdfError';
  }
}

/**
 * Encrypted PDFs reference an `/Encrypt` dictionary from their trailer (or,
 * in PDF 1.5+, from the xref stream's dictionary, which is never compressed),
 * so the token is always visible in the raw bytes.
 */
function isEncrypted(bytes: Uint8Array): boolean {
  return new TextDecoder('latin1').decode(bytes).includes('/Encrypt');
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Validate `file` and return it base64-encoded (no data: prefix). */
export async function readPdfForUpload(file: File): Promise<string> {
  if (file.size > MAX_PDF_BYTES) throw new PdfError('TOO_LARGE');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder('latin1').decode(bytes.subarray(0, 5)) !== '%PDF-') {
    throw new PdfError('NOT_PDF');
  }
  if (isEncrypted(bytes)) throw new PdfError('ENCRYPTED');
  return toBase64(file);
}

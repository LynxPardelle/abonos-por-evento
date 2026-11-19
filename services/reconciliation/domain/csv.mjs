import { DomainError } from '../../shared/http.mjs';
export const CSV_HEADER = 'provider,movement_id,participant_reference,amount,currency';
const invalid = (message) => { throw new DomainError(400, 'INVALID_CSV', message); };
function records(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false; let closed = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else cell += char;
    } else if (char === '"' && cell === '' && !closed) quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; closed = false; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); if (row.some((value) => value !== '')) rows.push(row);
      row = []; cell = ''; closed = false;
    } else { if (closed || char === '"') invalid('Comillas CSV inválidas.'); cell += char; }
  }
  if (quoted) invalid('Comillas CSV sin cierre.');
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
export function parseImport(csv, currency, participants) {
  if (typeof csv !== 'string' || Buffer.byteLength(csv, 'utf8') > 1048576) invalid('Límite de archivo: 1 MiB.');
  const parsed = records(csv.replace(/^\uFEFF/, ''));
  if (parsed.shift()?.join(',') !== CSV_HEADER) invalid(`Cabeceras requeridas: ${CSV_HEADER}`);
  if (!parsed.length || parsed.length > 500) invalid('Se requieren entre 1 y 500 movimientos por archivo.');
  const seen = new Set();
  return parsed.map((cells, index) => {
    const [provider = '', movementId = '', participantReference = '', amount = '', rowCurrency = ''] = cells.map((cell) => cell.trim());
    const row = { rowId: String(index + 2), provider, movementId, participantReference, currency: rowCurrency, status: 'rejected' };
    if (cells.length !== 5 || cells.some((cell) => cell.length > 160)) return { ...row, reason: 'Estructura o campo inválido.' };
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(provider) || !movementId || movementId.length > 120 || !participantReference) return { ...row, reason: 'Proveedor, movimiento y referencia son obligatorios.' };
    if (!/^(0|[1-9][0-9]{0,25})(\.[0-9]{1,2})?$/.test(amount)) return { ...row, reason: 'Importe decimal positivo con hasta dos decimales.' };
    const [whole, decimals = ''] = amount.split('.');
    row.amountMinor = (BigInt(whole) * 100n + BigInt(decimals.padEnd(2, '0'))).toString();
    if (row.amountMinor === '0' || rowCurrency !== currency) return { ...row, reason: 'Importe cero o moneda distinta al evento.' };
    const identity = JSON.stringify([provider, movementId]);
    if (seen.has(identity)) return { ...row, status: 'duplicate', reason: 'Movimiento repetido dentro del archivo.' };
    seen.add(identity);
    const matches = participants.filter((participant) => participant.reference === participantReference);
    if (matches.length === 1) return { ...row, status: 'suggested', suggestedParticipantId: matches[0].participantId, reason: 'Referencia exacta y única; requiere confirmación.' };
    return { ...row, status: matches.length ? 'ambiguous' : 'unmatched', reason: matches.length ? 'Referencia compartida por varios participantes.' : 'Sin referencia exacta.' };
  });
}

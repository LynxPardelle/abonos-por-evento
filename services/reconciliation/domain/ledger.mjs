import { createHash } from 'node:crypto';
import { DomainError } from '../../shared/http.mjs';
const messages = { OPERATION_CONFLICT: 'Esta operación ya se usó con otros datos.', VERSION_CONFLICT: 'El saldo cambió. Actualiza y revisa el abono.', DUPLICATE_MOVEMENT: 'Este movimiento ya fue confirmado.', ALREADY_REVERSED: 'El abono ya tiene un reverso.' };
const fail = (code) => { const error = new DomainError(409, code, messages[code]); throw error; };
export const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function operationId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(value)) throw new DomainError(400, 'INVALID_OPERATION', 'operationId inválido.');
  return value;
}
function identifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)) throw new DomainError(400, 'INVALID_IDENTIFIER', `${label} inválido.`);
  return value;
}
function expected(state, version) {
  if (!Number.isSafeInteger(version) || version < 0) throw new DomainError(400, 'INVALID_VERSION', 'expectedVersion debe ser un entero no negativo.');
  if (state.version !== version) fail('VERSION_CONFLICT');
}
function replay(state, op, signature) {
  const prior = state.movements.find((movement) => movement.operationId === op);
  if (!prior) return false;
  if (prior.requestFingerprint !== signature) fail('OPERATION_CONFLICT');
  return true;
}
export function createLedger(currency) {
  if (!/^[A-Z]{3}$/.test(currency)) throw new DomainError(400, 'INVALID_CURRENCY', 'Moneda inválida.');
  return { currency, version: 0, movements: [] };
}
export function applyPayment(state, input) {
  const request = { kind: 'payment', operationId: operationId(input.operationId), participantId: identifier(input.participantId, 'participantId'), itemId: identifier(input.itemId ?? 'registration', 'itemId'), provider: identifier(input.provider, 'provider'), externalMovementId: input.externalMovementId, amountMinor: input.amountMinor, currency: input.currency };
  if (typeof request.externalMovementId !== 'string' || !request.externalMovementId.trim() || request.externalMovementId.length > 120) throw new DomainError(400, 'INVALID_MOVEMENT', 'Referencia de movimiento inválida.');
  if (typeof request.amountMinor !== 'string' || !/^[1-9][0-9]{0,29}$/.test(request.amountMinor)) throw new DomainError(400, 'INVALID_AMOUNT', 'Importe entero positivo requerido.');
  if (request.currency !== state.currency) throw new DomainError(400, 'CURRENCY_MISMATCH', 'La moneda no corresponde al evento.');
  const signature = fingerprint(request);
  if (replay(state, request.operationId, signature)) return state;
  expected(state, input.expectedVersion);
  if (state.movements.some((movement) => movement.kind === 'payment' && movement.provider === request.provider && movement.externalMovementId === request.externalMovementId)) fail('DUPLICATE_MOVEMENT');
  const movement = { ...request, movementId: fingerprint({ operationId: request.operationId }), sequence: state.version + 1, requestFingerprint: signature };
  return { ...state, version: state.version + 1, movements: [...state.movements, movement] };
}
export function reversePayment(state, input) {
  const request = { kind: 'reversal', operationId: operationId(input.operationId), movementId: input.movementId };
  const signature = fingerprint(request);
  if (replay(state, request.operationId, signature)) return state;
  expected(state, input.expectedVersion);
  const original = state.movements.find((movement) => movement.movementId === input.movementId && movement.kind === 'payment');
  if (!original) throw new DomainError(404, 'MOVEMENT_NOT_FOUND', 'Abono original no encontrado.');
  if (state.movements.some((movement) => movement.reversalOf === original.movementId)) fail('ALREADY_REVERSED');
  const movement = { kind: 'reversal', movementId: fingerprint({ operationId: request.operationId }), operationId: request.operationId, participantId: original.participantId, itemId: original.itemId, currency: state.currency, amountMinor: (-BigInt(original.amountMinor)).toString(), reversalOf: original.movementId, sequence: state.version + 1, requestFingerprint: signature };
  return { ...state, version: state.version + 1, movements: [...state.movements, movement] };
}

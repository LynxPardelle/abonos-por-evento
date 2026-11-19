export class DomainError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'DomainError';
    this.status = status;
    this.statusCode = status;
    this.code = code;
  }
}

export function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
    body: JSON.stringify(body),
  };
}

export function handleError(error) {
  if (error instanceof DomainError) {
    return json(error.status, { error: { code: error.code, message: error.message } });
  }
  return json(500, { error: { code: 'INTERNAL_ERROR', message: 'No se pudo completar la operación.' } });
}

export function parseBody(event) {
  if (typeof event?.body !== 'string' || event.body.length === 0 || event.body.length > 1_400_000) {
    throw new DomainError(400, 'INVALID_BODY', 'Envía un objeto JSON válido de hasta 1 MB.');
  }
  try {
    const source = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    if (Buffer.byteLength(source, 'utf8') > 1_048_576) throw new Error('body-size');
    const body = JSON.parse(source);
    if (body === null || Array.isArray(body) || typeof body !== 'object') throw new Error('body-shape');
    return body;
  } catch {
    throw new DomainError(400, 'INVALID_BODY', 'Envía un objeto JSON válido de hasta 1 MB.');
  }
}

export function validateId(value, label = 'id') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)) {
    throw new DomainError(400, 'INVALID_ID', `${label} debe tener entre 1 y 80 letras, números, guiones o guiones bajos.`);
  }
  return value;
}

// Named execute-api stages are present in HTTP API v2 paths. SAM local and
// custom API mappings can omit them, so strip only the exact stage segment.
export function requestPath(event) {
  const path = event?.rawPath ?? event?.requestContext?.http?.path;
  if (typeof path !== 'string') return '';
  const stage = event?.requestContext?.stage;
  if (typeof stage === 'string' && stage !== '$default' && /^[A-Za-z0-9_-]+$/.test(stage)) {
    const prefix = `/${stage}`;
    if (path === prefix) return '/';
    if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length);
  }
  return path;
}

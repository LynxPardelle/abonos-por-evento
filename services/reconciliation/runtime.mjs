import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DomainError } from '../shared/http.mjs';
import { DynamoReconciliationRepository } from './repository.mjs';
export function createUploadSigner({ s3, bucketName }) {
  return async ({ key, sha256 }) => {
    const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: bucketName, Key: key, ContentType: 'text/csv', ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64') }), { expiresIn: 300 });
    return { url, method: 'PUT', headers: { 'content-type': 'text/csv' }, expiresIn: 300 };
  };
}
export function createAwsDependencies() {
  const lambda = new LambdaClient({}); const s3 = new S3Client({});
  async function invokeEvents(internal) {
    const response = await lambda.send(new InvokeCommand({ FunctionName: process.env.EVENTS_FUNCTION_NAME, Payload: Buffer.from(JSON.stringify({ internal })) }));
    if (response.FunctionError) throw new DomainError(503, 'EVENTS_UNAVAILABLE', 'El servicio de eventos no está disponible.');
    const payload = JSON.parse(Buffer.from(response.Payload).toString('utf8'));
    if (payload.statusCode) {
      const error = JSON.parse(payload.body ?? '{}').error;
      if ([400, 403, 404, 409, 413, 429].includes(payload.statusCode) && typeof error?.code === 'string') throw new DomainError(payload.statusCode, error.code, error.message);
      throw new DomainError(503, 'EVENTS_UNAVAILABLE', 'El servicio de eventos no está disponible.');
    }
    return payload;
  }
  return {
    repository: new DynamoReconciliationRepository(),
    eventReader: scope => invokeEvents({ action: 'getEvent', ...scope }),
    eventCommand: (action, scope, input, actor) => invokeEvents({ action, ...scope, ...input, actor }),
    eventLister: actor => invokeEvents({ action: 'listEventsforOverview', organizationId: actor.organizationId, actor }),
    uploadSigner: createUploadSigner({ s3, bucketName: process.env.IMPORTS_BUCKET }),
    async objectReader({ bucket, key }) {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (response.ContentLength > 1048576) throw new DomainError(413, 'IMPORT_TOO_LARGE', 'El archivo supera 1 MiB.');
      const chunks = []; let size = 0;
      for await (const chunk of response.Body) { size += chunk.length; if (size > 1048576) { response.Body.destroy?.(); throw new DomainError(413, 'IMPORT_TOO_LARGE', 'El archivo supera 1 MiB.'); } chunks.push(chunk); }
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}

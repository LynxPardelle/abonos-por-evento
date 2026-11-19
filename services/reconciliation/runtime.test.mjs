import test from 'node:test';
import assert from 'node:assert/strict';
import { S3Client } from '@aws-sdk/client-s3';
import { createUploadSigner } from './runtime.mjs';
test('presigned PUT binds the expected CSV checksum instead of the checksum of an empty body', async () => {
  const s3 = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'synthetic-access', secretAccessKey: 'synthetic-secret' } });
  const sha256 = 'a'.repeat(64);
  const signer = createUploadSigner({ s3, bucketName: 'synthetic-imports' });
  const upload = await signer({ key: 'synthetic/input.csv', sha256 });
  const url = new URL(upload.url);
  assert.equal(url.searchParams.get('x-amz-checksum-sha256'), Buffer.from(sha256, 'hex').toString('base64'));
  assert.equal(url.searchParams.has('x-amz-checksum-crc32'), false);
  assert.equal(upload.method, 'PUT');
});

import { createReconciliationService } from './application.mjs';
import { createAwsDependencies } from './runtime.mjs';
export function createImportWorker({ service, objectReader, bucketName = process.env.IMPORTS_BUCKET }) {
  return async (event) => {
    const batchItemFailures = [];
    for (const message of event.Records ?? []) {
      try {
        const notification = JSON.parse(message.body);
        if (notification.Event === 's3:TestEvent') continue;
        if (!Array.isArray(notification.Records) || notification.Records.length === 0) throw new Error('Invalid S3 notification');
        for (const record of notification.Records) {
          const bucket = record.s3?.bucket?.name;
          const key = decodeURIComponent((record.s3?.object?.key ?? '').replace(/\+/g, ' '));
          const match = /^tenants\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})\/events\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})\/imports\/([a-f0-9]{64})\/input\.csv$/.exec(key);
          if (bucket !== bucketName || !match) throw new Error('Invalid import object');
          const csv = await objectReader({ bucket, key });
          await service.processImport({ organizationId: match[1], eventId: match[2], batchId: match[3], csv });
        }
      } catch { batchItemFailures.push({ itemIdentifier: message.messageId }); }
    }
    return { batchItemFailures };
  };
}
let defaultWorker;
export async function handler(event) {
  if (!defaultWorker) { const dependencies = createAwsDependencies(); defaultWorker = createImportWorker({ service: createReconciliationService(dependencies), objectReader: dependencies.objectReader }); }
  return defaultWorker(event);
}

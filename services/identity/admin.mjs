import { handleError } from "../shared/http.mjs";
import { createAccountsService } from "./accounts.mjs";
import { DynamoAccountsRepository } from "./accounts-repository.mjs";
import {
  createEventUsageReader,
  internalCommand,
} from "./accounts-runtime.mjs";

export function createAdminHandler({ service, userPoolId }) {
  return async (event) => {
    try {
      return await service.admin(
        internalCommand(event, ["grantPlan", "grantMember"], userPoolId),
      );
    } catch (error) {
      return handleError(error);
    }
  };
}
let runtime;
export async function handler(event) {
  try {
    runtime ??= createAdminHandler({
      service: createAccountsService({
        repository: new DynamoAccountsRepository(),
        usageReader: createEventUsageReader(),
        userPoolId: process.env.USER_POOL_ID,
      }),
      userPoolId: process.env.USER_POOL_ID,
    });
    return runtime(event);
  } catch (error) {
    return handleError(error);
  }
}

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPlan } from "../services/shared/plans.mjs";

const account = "765932874577";
const region = "us-east-1";
const targets = Object.freeze({
  "saldoevento-dev": {
    stage: "dev",
    origin: "https://saldoevento-dev.lynxpardelle.com",
  },
  "saldoevento-test": {
    stage: "test",
    origin: "https://saldoevento-test.lynxpardelle.com",
  },
  "saldoevento-prod": {
    stage: "prod",
    origin: "https://saldoevento.zooberiahsystems.com",
  },
});
const requireCheck = (ok, code) => {
  if (!ok) throw Object.assign(new Error(code), { code });
};
const identifier = (value) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);

export function parseGrantArgs(argv) {
  const options = {
    action: "grantPlan",
    execute: false,
    allowProduction: false,
  };
  const seen = new Set();
  const names = {
    "--stack": "stack",
    "--action": "action",
    "--subject": "subject",
    "--organization-id": "organizationId",
    "--plan": "code",
    "--expected-version": "expectedVersion",
    "--operation-id": "operationId",
    "--roles": "roles",
    "--event-ids": "eventIds",
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    requireCheck(!seen.has(key), "DUPLICATE_ARGUMENT");
    seen.add(key);
    if (key === "--execute") options.execute = true;
    else if (key === "--allow-production") options.allowProduction = true;
    else {
      requireCheck(
        Object.hasOwn(names, key) &&
          typeof argv[i + 1] === "string" &&
          !argv[i + 1].startsWith("--"),
        "INVALID_ARGUMENT",
      );
      options[names[key]] = argv[++i];
    }
  }
  requireCheck(
    Object.hasOwn(targets, options.stack ?? ""),
    "APPROVED_STACK_REQUIRED",
  );
  requireCheck(
    ["grantPlan", "grantMember"].includes(options.action),
    "INVALID_ACTION",
  );
  requireCheck(
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(
      options.subject ?? "",
    ) &&
      identifier(options.organizationId) &&
      identifier(options.operationId),
    "SUBJECT_ORGANIZATION_OPERATION_REQUIRED",
  );
  requireCheck(
    /^\d+$/.test(options.expectedVersion ?? "") &&
      Number.isSafeInteger(Number(options.expectedVersion)),
    "EXPECTED_VERSION_REQUIRED",
  );
  options.expectedVersion = Number(options.expectedVersion);
  if (options.action === "grantPlan") {
    getPlan(options.code);
    requireCheck(
      options.roles === undefined && options.eventIds === undefined,
      "PLAN_ARGUMENTS_ONLY",
    );
  } else {
    requireCheck(
      options.code === undefined && typeof options.roles === "string",
      "MEMBER_ARGUMENTS_REQUIRED",
    );
    options.roles = options.roles.split(",");
    requireCheck(
      options.roles.length > 0 &&
        new Set(options.roles).size === options.roles.length &&
        options.roles.every((role) =>
          ["operator", "importer", "confirmer", "auditor"].includes(role),
        ),
      "COLLABORATOR_ROLES_REQUIRED",
    );
    if (options.eventIds !== undefined) {
      options.eventIds = options.eventIds.split(",");
      requireCheck(
        options.eventIds.length > 0 &&
          options.eventIds.length <= 50 &&
          new Set(options.eventIds).size === options.eventIds.length &&
          options.eventIds.every(identifier),
        "INVALID_EVENT_SCOPE",
      );
    }
  }
  requireCheck(
    !(
      options.stack === "saldoevento-prod" &&
      options.execute &&
      !options.allowProduction
    ),
    "PRODUCTION_APPROVAL_FLAG_REQUIRED",
  );
  return options;
}

function readAws(service, operation, args) {
  requireCheck(
    ["sts/get-caller-identity", "cloudformation/describe-stacks"].includes(
      `${service}/${operation}`,
    ),
    "READ_OPERATION_REQUIRED",
  );
  const query =
    service === "sts"
      ? "{Account:Account,Arn:Arn}"
      : "Stacks[0].{StackName:StackName,StackStatus:StackStatus,Parameters:Parameters,Outputs:Outputs[?OutputKey=='UserPoolId' || OutputKey=='IdentityAdminFunctionName' || OutputKey=='ProductDomain']}";
  try {
    return JSON.parse(
      execFileSync(
        "aws",
        [
          service,
          operation,
          ...args,
          "--query",
          query,
          "--region",
          region,
          "--output",
          "json",
          "--no-cli-pager",
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30_000,
        },
      ),
    );
  } catch {
    throw Object.assign(new Error("ADMIN_PREFLIGHT_READ_FAILED"), {
      code: "ADMIN_PREFLIGHT_READ_FAILED",
    });
  }
}
async function invoke(functionName, payload) {
  const require = createRequire(
    new URL("../services/package.json", import.meta.url),
  );
  const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");
  const response = await new LambdaClient({ region }).send(
    new InvokeCommand({
      FunctionName: functionName,
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
  requireCheck(!response.FunctionError, "ADMIN_INVOKE_FAILED");
  const result = JSON.parse(Buffer.from(response.Payload).toString("utf8"));
  if (result.statusCode) {
    const body = JSON.parse(result.body ?? "{}");
    requireCheck(false, body.error?.code ?? "ADMIN_GRANT_REJECTED");
  }
  return result;
}

export async function runGrant(options, dependencies = {}) {
  const read = dependencies.readAws ?? readAws;
  const target = targets[options.stack];
  requireCheck(
    target &&
      !(target.stage === "prod" && options.execute && !options.allowProduction),
    "APPROVED_STACK_REQUIRED",
  );
  const identity = await read("sts", "get-caller-identity", []);
  requireCheck(identity.Account === account, "AWS_ACCOUNT_MISMATCH");
  const stack = await read("cloudformation", "describe-stacks", [
    "--stack-name",
    options.stack,
  ]);
  const params = Object.fromEntries(
    (stack?.Parameters ?? []).map((item) => [
      item.ParameterKey,
      item.ParameterValue,
    ]),
  );
  const outputs = Object.fromEntries(
    (stack?.Outputs ?? []).map((item) => [item.OutputKey, item.OutputValue]),
  );
  requireCheck(
    stack?.StackName === options.stack &&
      ["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(stack.StackStatus) &&
      params.Stage === target.stage &&
      params.PublicOrigin === target.origin &&
      outputs.ProductDomain === new URL(target.origin).hostname,
    "STACK_TARGET_MISMATCH",
  );
  const functionName = `saldoevento-${target.stage}-identity-admin`;
  requireCheck(
    outputs.IdentityAdminFunctionName === functionName &&
      /^us-east-1_[A-Za-z0-9]+$/.test(outputs.UserPoolId ?? ""),
    "ADMIN_FUNCTION_TARGET_MISMATCH",
  );
  const payload = {
    internal: {
      action: options.action,
      userPoolId: outputs.UserPoolId,
      subject: options.subject,
      organizationId: options.organizationId,
      operationId: options.operationId,
      expectedVersion: options.expectedVersion,
      ...(options.action === "grantPlan"
        ? { code: options.code }
        : {
            roles: options.roles,
            ...(options.eventIds ? { eventIds: options.eventIds } : {}),
          }),
      operatorReference: identity.Arn ?? "authorized-iam-operator",
    },
  };
  if (!options.execute)
    return {
      status: "preview",
      stack: options.stack,
      functionName,
      billingEnabled: false,
      payload,
    };
  const result = await (dependencies.invoke ?? invoke)(functionName, payload);
  return {
    status: "applied",
    stack: options.stack,
    action: options.action,
    operationId: options.operationId,
    billingEnabled: false,
    result,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(
      JSON.stringify(
        await runGrant(parseGrantArgs(process.argv.slice(2))),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        status: "failed",
        code: error.code ?? "ADMIN_GRANT_FAILED",
      }),
    );
    process.exitCode = 1;
  }
}

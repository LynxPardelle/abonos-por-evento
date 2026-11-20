import assert from "node:assert/strict";
import test from "node:test";
const cli = await import("./Grant-EvaluationPlan.mjs").catch(() => ({}));
const subject = "11111111-1111-4111-8111-111111111111";
const argv = [
  "--stack",
  "saldoevento-test",
  "--subject",
  subject,
  "--organization-id",
  "org-synthetic",
  "--plan",
  "team",
  "--expected-version",
  "0",
  "--operation-id",
  "evaluation-team-1",
];
const stack = {
  StackName: "saldoevento-test",
  StackStatus: "CREATE_COMPLETE",
  Parameters: [
    { ParameterKey: "Stage", ParameterValue: "test" },
    {
      ParameterKey: "PublicOrigin",
      ParameterValue: "https://saldoevento-test.lynxpardelle.com",
    },
  ],
  Outputs: [
    { OutputKey: "UserPoolId", OutputValue: "us-east-1_Synthetic" },
    {
      OutputKey: "IdentityAdminFunctionName",
      OutputValue: "saldoevento-test-identity-admin",
    },
    {
      OutputKey: "ProductDomain",
      OutputValue: "saldoevento-test.lynxpardelle.com",
    },
  ],
};

test("IAM grant CLI defaults to preview and rejects unapproved production execution", () => {
  assert.equal(typeof cli.parseGrantArgs, "function");
  const options = cli.parseGrantArgs(argv);
  assert.equal(options.execute, false);
  assert.equal(options.code, "team");
  assert.throws(() => cli.parseGrantArgs([...argv, "--plan", "pilot"]));
  assert.throws(() =>
    cli.parseGrantArgs(
      argv.map((value) => (value === "team" ? "premium" : value)),
    ),
  );
  assert.throws(
    () =>
      cli.parseGrantArgs([
        ...argv.map((value) =>
          value === "saldoevento-test" ? "saldoevento-prod" : value,
        ),
        "--execute",
      ]),
    /PRODUCTION_APPROVAL_FLAG_REQUIRED/,
  );
  assert.equal(
    cli.parseGrantArgs([
      ...argv.map((value) =>
        value === "saldoevento-test" ? "saldoevento-prod" : value,
      ),
      "--execute",
      "--allow-production",
    ]).execute,
    true,
  );
});

test("preview performs only two configuration reads and never invokes the writer", async () => {
  assert.equal(typeof cli.runGrant, "function");
  const reads = [];
  let invokes = 0;
  const preview = await cli.runGrant(cli.parseGrantArgs(argv), {
    readAws: (service, operation) => {
      reads.push(`${service}/${operation}`);
      return service === "sts"
        ? {
            Account: "765932874577",
            Arn: "arn:aws:iam::765932874577:user/synthetic-operator",
          }
        : stack;
    },
    invoke: async () => {
      invokes++;
    },
  });
  assert.equal(preview.status, "preview");
  assert.equal(invokes, 0);
  assert.deepEqual(reads, [
    "sts/get-caller-identity",
    "cloudformation/describe-stacks",
  ]);
  assert.equal(preview.payload.internal.code, "team");
  assert.equal(preview.payload.internal.userPoolId, "us-east-1_Synthetic");
  assert.equal(preview.functionName, "saldoevento-test-identity-admin");
});

test("production preview requires the new primary domain without changing its identity function", async () => {
  const options = cli.parseGrantArgs(argv.map(value => value === 'saldoevento-test' ? 'saldoevento-prod' : value));
  const production = {
    ...stack, StackName: 'saldoevento-prod',
    Parameters: [{ ParameterKey: 'Stage', ParameterValue: 'prod' }, { ParameterKey: 'PublicOrigin', ParameterValue: 'https://saldoevento.zooberiahsystems.com' }],
    Outputs: stack.Outputs.map(item => ({ ...item, OutputValue: item.OutputKey === 'ProductDomain' ? 'saldoevento.zooberiahsystems.com' : item.OutputKey === 'IdentityAdminFunctionName' ? 'saldoevento-prod-identity-admin' : item.OutputValue })),
  };
  const readAws = service => service === 'sts' ? { Account: '765932874577' } : production;
  const preview = await cli.runGrant(options, { readAws });
  assert.equal(preview.status, 'preview');
  assert.equal(preview.functionName, 'saldoevento-prod-identity-admin');
  assert.equal(preview.payload.internal.userPoolId, 'us-east-1_Synthetic');
  await assert.rejects(cli.runGrant(options, { readAws: service => service === 'sts' ? { Account: '765932874577' } : { ...production, Parameters: production.Parameters.map(item => item.ParameterKey === 'PublicOrigin' ? { ...item, ParameterValue: 'https://saldoevento.lynxpardelle.com' } : item) } }), /STACK_TARGET_MISMATCH/);
});

test("execute invokes only the guarded admin function and preserves the operation ID", async () => {
  assert.equal(typeof cli.runGrant, "function");
  let captured;
  const result = await cli.runGrant(
    cli.parseGrantArgs([...argv, "--execute"]),
    {
      readAws: (service) =>
        service === "sts"
          ? { Account: "765932874577", Arn: "synthetic" }
          : stack,
      invoke: async (functionName, payload) => {
        captured = { functionName, payload };
        return { plan: { code: "team", billingEnabled: false } };
      },
    },
  );
  assert.equal(result.status, "applied");
  assert.equal(captured.functionName, "saldoevento-test-identity-admin");
  assert.equal(captured.payload.internal.operationId, "evaluation-team-1");
  assert.equal(captured.payload.internal.action, "grantPlan");
  assert.equal(result.result.plan.billingEnabled, false);
});

test("member grants forbid administrator roles and wrong-stack identity outputs", async () => {
  assert.equal(typeof cli.parseGrantArgs, "function");
  const memberArgs = [
    "--stack",
    "saldoevento-test",
    "--action",
    "grantMember",
    "--subject",
    subject,
    "--organization-id",
    "org-synthetic",
    "--roles",
    "importer,auditor",
    "--event-ids",
    "event-a,event-b",
    "--expected-version",
    "2",
    "--operation-id",
    "add-member",
  ];
  const options = cli.parseGrantArgs(memberArgs);
  assert.deepEqual(options.roles, ["importer", "auditor"]);
  assert.throws(() =>
    cli.parseGrantArgs(
      memberArgs.map((value) =>
        value === "importer,auditor" ? "admin" : value,
      ),
    ),
  );
  await assert.rejects(
    cli.runGrant(options, {
      readAws: (service) =>
        service === "sts"
          ? { Account: "765932874577" }
          : {
              ...stack,
              Outputs: stack.Outputs.map((item) =>
                item.OutputKey === "IdentityAdminFunctionName"
                  ? { ...item, OutputValue: "saldoevento-prod-identity-admin" }
                  : item,
              ),
            },
    }),
    /ADMIN_FUNCTION_TARGET_MISMATCH/,
  );
});

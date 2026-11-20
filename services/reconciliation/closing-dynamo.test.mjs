import assert from "node:assert/strict";
import test from "node:test";
import { DynamoReconciliationRepository } from "./repository.mjs";
import { applyPayment } from "./domain/ledger.mjs";

const scope = { organizationId: "org-dynamo", eventId: "event-dynamo" };
const pk = `ORG#${scope.organizationId}#EVENT#${scope.eventId}`;
const actor = {
  organizationId: scope.organizationId,
  subject: "11111111-1111-4111-8111-111111111111",
  roles: ["admin"],
  accessGuards: [
    {
      key: { pk: "POOL#us-east-1_Test#USER#owner", sk: "MEMBERSHIP" },
      data: { status: "active", roles: ["admin"] },
    },
    {
      key: { pk: `ORG#${scope.organizationId}`, sk: "PLAN" },
      data: { code: "organizer", version: 1 },
    },
  ],
};
const snapshot = (extra) => ({
  closureId: "close-dynamo",
  operationId: "close-request",
  currency: "MXN",
  ledgerVersion: 0,
  lifecycleVersion: 1,
  rosterRevision: 4,
  balances: [],
  totals: {
    currency: "MXN",
    agreedMinor: "0",
    paidMinor: "0",
    pendingMinor: "0",
  },
  movements: [],
  ...extra,
});
const encode = (table, key) => JSON.stringify([table, key.pk, key.sk]);

// This fixture models AWS's all-or-nothing transaction boundary, not a general
// DynamoDB expression interpreter. Separate assertions inspect every condition.
function fixture({ cancel = false } = {}) {
  const items = new Map();
  const calls = [];
  const store = (table, item) =>
    items.set(encode(table, item), structuredClone(item));
  const client = {
    send: async (command) => {
      calls.push(command);
      const input = command.input;
      if (command.constructor.name === "GetCommand")
        return {
          Item: structuredClone(items.get(encode(input.TableName, input.Key))),
        };
      if (command.constructor.name === "QueryCommand") {
        const { ":pk": requestedPk, ":prefix": prefix } =
          input.ExpressionAttributeValues;
        return {
          Items: [...items.entries()]
            .filter(
              ([key, item]) =>
                JSON.parse(key)[0] === input.TableName &&
                item.pk === requestedPk &&
                item.sk.startsWith(prefix),
            )
            .map(([, item]) => structuredClone(item)),
        };
      }
      assert.equal(
        command.constructor.name,
        "TransactWriteCommand",
        "Every financial write must use one Dynamo transaction",
      );
      if (cancel)
        throw Object.assign(new Error("Synthetic conditional rejection"), {
          name: "TransactionCanceledException",
          CancellationReasons: input.TransactItems.map((item) => ({
            Code: (
              cancel === "identity"
                ? item.ConditionCheck?.TableName === "Identity"
                : item.Put?.Item.sk === "LEDGER"
            )
              ? "ConditionalCheckFailed"
              : "None",
          })),
        });
      for (const item of input.TransactItems)
        if (item.Put) store(item.Put.TableName, item.Put.Item);
      return {};
    },
  };
  const repository = new DynamoReconciliationRepository({
    tableName: "Reconciliation",
    identityTableName: "Identity",
    client,
  });
  return {
    repository,
    calls,
    items,
    store,
    get: (table, key) => items.get(encode(table, key)),
    transactions: () =>
      calls
        .filter((call) => call.constructor.name === "TransactWriteCommand")
        .map((call) => call.input.TransactItems),
  };
}

function assertIdentityGuards(transaction) {
  const guards = transaction.filter(
    (item) => item.ConditionCheck?.TableName === "Identity",
  );
  assert.equal(guards.length, actor.accessGuards.length);
  assert.deepEqual(
    guards.map((item) => item.ConditionCheck.Key),
    actor.accessGuards.map((item) => item.key),
  );
  assert.deepEqual(
    guards.map(
      (item) => item.ConditionCheck.ExpressionAttributeValues[":snapshot"],
    ),
    actor.accessGuards.map((item) => item.data),
  );
  assert.ok(
    guards.every(
      (item) => item.ConditionCheck.ConditionExpression === "#data = :snapshot",
    ),
  );
  assert.ok(
    transaction
      .filter((item) => item.Put)
      .every((item) => item.Put.TableName === "Reconciliation"),
    "Identity participates only as read conditions",
  );
  const keys = transaction.map((item) => {
    const operation = item.Put ?? item.ConditionCheck;
    return encode(operation.TableName, operation.Item ?? operation.Key);
  });
  assert.equal(
    new Set(keys).size,
    keys.length,
    "A transaction must never target the same item twice",
  );
}

test("Dynamo financial close writes immutable snapshot and closed metadata in one guarded transaction", async () => {
  const { repository, transactions } = fixture();
  const captured = snapshot({
    ledgerVersion: 2,
    lifecycleVersion: 8,
    balances: [{ participantId: "ana", paidMinor: "50000" }],
  });
  await repository.closeLedger(
    scope,
    captured,
    { ledgerVersion: 2, lifecycleVersion: 7, metaExists: true },
    actor,
  );
  assert.equal(transactions().length, 1);
  const transaction = transactions()[0];
  assertIdentityGuards(transaction);
  const metadata = transaction.find(
    (item) => item.Put?.Item.sk === "LEDGER",
  ).Put;
  const closure = transaction.find(
    (item) => item.Put?.Item.sk === `CLOSURE#${captured.closureId}`,
  ).Put;
  assert.equal(transaction.filter((item) => item.Put).length, 2);
  assert.deepEqual(closure.Item.data, captured);
  assert.equal(closure.ConditionExpression, "attribute_not_exists(pk)");
  assert.equal(metadata.Item.version, 2);
  assert.equal(metadata.Item.data.version, 2);
  assert.equal(metadata.Item.data.financialStatus, "closed");
  assert.equal(metadata.Item.data.lifecycleVersion, 8);
  assert.equal(metadata.Item.data.currentClosureId, captured.closureId);
  assert.equal(metadata.ExpressionAttributeValues[":previous"], 2);
  assert.equal(metadata.ExpressionAttributeValues[":lifecycle"], 7);
  assert.equal(metadata.ExpressionAttributeValues[":open"], "open");
  assert.match(metadata.ConditionExpression, /#version = :previous/);
  assert.match(metadata.ConditionExpression, /#data\.#status = :open/);
  assert.match(metadata.ConditionExpression, /#data\.#lifecycle = :lifecycle/);
});

test("empty close and reopen persist metadata version zero so the first payment checks version zero instead of absence", async () => {
  const { repository, transactions } = fixture();
  const captured = snapshot();
  await repository.closeLedger(
    scope,
    captured,
    { ledgerVersion: 0, lifecycleVersion: 0, metaExists: false },
    actor,
  );
  await repository.reopenLedger(
    scope,
    {
      operationId: "reopen-empty",
      closureId: captured.closureId,
      currency: "MXN",
      lifecycleVersion: 2,
    },
    { ledgerVersion: 0, lifecycleVersion: 1 },
    actor,
  );
  const state = await repository.loadLedger(scope, "MXN");
  assert.equal(state.version, 0);
  assert.equal(state.metaExists, true);
  assert.equal(state.lifecycleVersion, 2);
  assert.equal(state.financialStatus, "open");
  const paid = applyPayment(state, {
    operationId: "first-payment",
    participantId: "ana",
    provider: "manual",
    externalMovementId: "receipt-1",
    amountMinor: "50000",
    currency: "MXN",
    expectedVersion: 0,
  });
  await repository.commit(scope, paid, 0, undefined, actor);
  const payment = transactions()
    .at(-1)
    .find((item) => item.Put?.Item.sk === "LEDGER").Put;
  assert.notEqual(payment.ConditionExpression, "attribute_not_exists(pk)");
  assert.equal(payment.ExpressionAttributeValues[":previous"], 0);
  assert.equal(payment.ExpressionAttributeValues[":lifecycle"], 2);
  assert.equal(payment.Item.version, 1);
  assert.equal(payment.Item.data.lifecycleVersion, 2);
  assert.ok(
    transactions().every((transaction) => {
      assertIdentityGuards(transaction);
      return true;
    }),
  );
});

test("Dynamo reopen atomically writes lifecycle operation and requires the exact closed generation", async () => {
  const { repository, transactions } = fixture();
  const operation = {
    operationId: "resume-closed",
    closureId: "close-original",
    currency: "MXN",
    lifecycleVersion: 5,
    createdBy: actor.subject,
  };
  await repository.reopenLedger(
    scope,
    operation,
    { ledgerVersion: 3, lifecycleVersion: 4 },
    actor,
  );
  const transaction = transactions()[0];
  assertIdentityGuards(transaction);
  const metadata = transaction.find(
    (item) => item.Put?.Item.sk === "LEDGER",
  ).Put;
  const record = transaction.find((item) =>
    item.Put?.Item.sk.startsWith("LIFECYCLE#"),
  ).Put;
  assert.equal(metadata.ExpressionAttributeValues[":closed"], "closed");
  assert.equal(metadata.ExpressionAttributeValues[":previous"], 3);
  assert.equal(metadata.ExpressionAttributeValues[":lifecycle"], 4);
  assert.equal(metadata.Item.data.financialStatus, "open");
  assert.equal(metadata.Item.data.lifecycleVersion, 5);
  assert.deepEqual(record.Item.data, operation);
  assert.equal(record.ConditionExpression, "attribute_not_exists(pk)");
});

test("import initialization includes open-ledger and current Identity conditions in its single transaction", async () => {
  const { repository, transactions } = fixture();
  const batch = {
    batchId: "a".repeat(64),
    batchVersion: 0,
    status: "awaiting_upload",
    rows: [],
    fileName: "example.csv",
  };
  await repository.createBatch(scope, batch, "upload-example", actor);
  assert.equal(transactions().length, 1);
  const transaction = transactions()[0];
  assertIdentityGuards(transaction);
  const open = transaction.find(
    (item) =>
      item.ConditionCheck?.TableName === "Reconciliation" &&
      item.ConditionCheck.Key.sk === "LEDGER",
  ).ConditionCheck;
  assert.match(open.ConditionExpression, /#data\.#status = :open/);
  assert.equal(open.ExpressionAttributeValues[":open"], "open");
  assert.equal(
    transaction.filter((item) => item.Put?.Item.sk.startsWith("BATCH#")).length,
    1,
  );
  assert.equal(
    transaction.filter((item) => item.Put?.Item.sk.startsWith("UPLOAD#"))
      .length,
    1,
  );
});

for (const rejection of ["ledger was closed", "membership was revoked"]) {
  test(`cancelled payment after ${rejection} does not emit separate movement or balance writes`, async () => {
    const membershipRejection = rejection === "membership was revoked";
    const state = fixture({
      cancel: membershipRejection ? "identity" : "ledger",
    });
    const prior = {
      pk,
      sk: "LEDGER",
      version: 0,
      data: {
        version: 0,
        currency: "MXN",
        financialStatus: membershipRejection ? "open" : "closed",
        lifecycleVersion: membershipRejection ? 2 : 3,
      },
    };
    state.store("Reconciliation", prior);
    if (membershipRejection)
      state.store("Identity", {
        ...actor.accessGuards[0].key,
        data: { status: "revoked", roles: ["auditor"] },
      });
    const initialItems = structuredClone([...state.items.entries()]);
    const stale = {
      version: 0,
      currency: "MXN",
      movements: [],
      financialStatus: "open",
      lifecycleVersion: 2,
      metaExists: true,
    };
    const paid = applyPayment(stale, {
      operationId: `payment-${rejection.replaceAll(" ", "-")}`,
      participantId: "ana",
      provider: "manual",
      externalMovementId: "receipt",
      amountMinor: "50000",
      currency: "MXN",
      expectedVersion: 0,
    });
    await assert.rejects(
      state.repository.commit(scope, paid, 0, undefined, actor),
      { code: "VERSION_CONFLICT" },
    );
    assert.deepEqual(state.get("Reconciliation", { pk, sk: "LEDGER" }), prior);
    assert.deepEqual([...state.items.entries()], initialItems);
    assert.equal(state.transactions().length, 1);
    assertIdentityGuards(state.transactions()[0]);
  });
}

test("cancelled close or reopen leaves both metadata and immutable records unchanged", async () => {
  for (const action of ["close", "reopen"]) {
    const state = fixture({ cancel: true });
    const prior = {
      pk,
      sk: "LEDGER",
      version: 2,
      data: {
        version: 2,
        currency: "MXN",
        financialStatus: action === "close" ? "open" : "closed",
        lifecycleVersion: 4,
      },
    };
    state.store("Reconciliation", prior);
    if (action === "close")
      await assert.rejects(
        state.repository.closeLedger(
          scope,
          snapshot({ ledgerVersion: 2, lifecycleVersion: 5 }),
          { ledgerVersion: 2, lifecycleVersion: 4, metaExists: true },
          actor,
        ),
        { code: "VERSION_CONFLICT" },
      );
    else
      await assert.rejects(
        state.repository.reopenLedger(
          scope,
          {
            operationId: "reopen-rejected",
            closureId: "close-before",
            currency: "MXN",
          },
          { ledgerVersion: 2, lifecycleVersion: 4 },
          actor,
        ),
        { code: "VERSION_CONFLICT" },
      );
    assert.deepEqual(state.get("Reconciliation", { pk, sk: "LEDGER" }), prior);
    assert.equal(state.items.size, 1);
    assert.equal(state.transactions().length, 1);
    assertIdentityGuards(state.transactions()[0]);
  }
});

test("oversize Dynamo closure rejects before requesting any write", async () => {
  const { repository, calls } = fixture();
  await assert.rejects(
    repository.closeLedger(
      scope,
      snapshot({ eventName: "x".repeat(300_001) }),
      { ledgerVersion: 0, lifecycleVersion: 0, metaExists: false },
      actor,
    ),
    { code: "CLOSURE_TOO_LARGE" },
  );
  assert.equal(calls.length, 0);
});

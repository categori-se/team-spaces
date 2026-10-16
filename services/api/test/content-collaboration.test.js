// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import {applyTextOperation, clientOperationsToTextOperation, composeTextOperations, replacementTextOperation, transformTextOperation} from "../src/repositories/content-collaboration.js";

test("composes sequential editor operations without replacing unrelated content", () => {
  const base = "alpha beta gamma";
  const operation = clientOperationsToTextOperation(base, [
    {type: "delete", index: 6, count: 4},
    {type: "insert", index: 6, text: "BETA"},
    {type: "insert", index: 16, text: "!"}
  ]);
  assert.equal(applyTextOperation(base, operation), "alpha BETA gamma!");
  assert.equal(applyTextOperation(base, replacementTextOperation(base, "alpha BETA gamma!")), "alpha BETA gamma!");
  assert.equal(applyTextOperation(base, composeTextOperations([{retain: base.length}], operation)), "alpha BETA gamma!");
});

test("concurrent operations converge regardless of arrival order", () => {
  const base = "Shared note";
  const first = clientOperationsToTextOperation(base, [{type: "insert", index: 0, text: "A: "}]);
  const second = clientOperationsToTextOperation(base, [{type: "insert", index: 0, text: "B: "}]);

  const afterFirst = applyTextOperation(applyTextOperation(base, first), transformTextOperation(second, first, {operationKey: "b", remoteKey: "a"}));
  const afterSecond = applyTextOperation(applyTextOperation(base, second), transformTextOperation(first, second, {operationKey: "a", remoteKey: "b"}));
  assert.equal(afterFirst, "A: B: Shared note");
  assert.equal(afterSecond, afterFirst);
});

test("concurrent replacements retain both authors' text deterministically", () => {
  const base = "Status: draft";
  const first = clientOperationsToTextOperation(base, [{type: "delete", index: 8, count: 5}, {type: "insert", index: 8, text: "ready"}]);
  const second = clientOperationsToTextOperation(base, [{type: "delete", index: 8, count: 5}, {type: "insert", index: 8, text: "review"}]);
  const firstThenSecond = applyTextOperation(applyTextOperation(base, first), transformTextOperation(second, first, {operationKey: "b", remoteKey: "a"}));
  const secondThenFirst = applyTextOperation(applyTextOperation(base, second), transformTextOperation(first, second, {operationKey: "a", remoteKey: "b"}));
  assert.equal(firstThenSecond, secondThenFirst);
  assert.equal(firstThenSecond, "Status: readyreview");
});

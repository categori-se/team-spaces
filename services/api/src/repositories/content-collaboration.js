// @ts-nocheck

import {ConflictError, ValidationError} from "../errors.js";

function componentType(component) {
  if (component.retain !== undefined) return "retain";
  if (component.insert !== undefined) return "insert";
  if (component.delete !== undefined) return "delete";
  throw new ValidationError("Collaborative text operation is invalid");
}

function componentLength(component) {
  const type = componentType(component);
  return type === "insert" ? component.insert.length : Number(component[type]);
}

function componentPart(component, length) {
  const type = componentType(component);
  return type === "insert" ? {insert: component.insert.slice(0, length)} : {[type]: length};
}

function appendComponent(operation, component) {
  const type = componentType(component);
  const length = componentLength(component);
  if (!Number.isInteger(length) || length < 0 || type === "insert" && typeof component.insert !== "string") throw new ValidationError("Collaborative text operation is invalid");
  if (!length) return;
  const previous = operation.at(-1);
  if (previous && componentType(previous) === type) {
    if (type === "insert") previous.insert += component.insert;
    else previous[type] += length;
  } else operation.push(componentPart(component, length));
}

function operationIterator(operation) {
  let index = 0;
  let offset = 0;
  return {
    peek() {
      const component = operation[index];
      if (!component) return undefined;
      const type = componentType(component);
      return type === "insert" ? {insert: component.insert.slice(offset)} : {[type]: Number(component[type]) - offset};
    },
    consume(length) {
      const component = operation[index];
      if (!component || length < 1 || length > componentLength(component) - offset) throw new ValidationError("Collaborative text operation cannot be consumed");
      offset += length;
      if (offset === componentLength(component)) {
        index += 1;
        offset = 0;
      }
    }
  };
}

function inputLength(operation) {
  return operation.reduce((sum, component) => sum + (component.retain ?? component.delete ?? 0), 0);
}

function outputLength(operation) {
  return operation.reduce((sum, component) => sum + (component.retain ?? component.insert?.length ?? 0), 0);
}

function identity(length) {
  return length ? [{retain: length}] : [];
}

function primitiveOperation(length, operation) {
  if (operation.index > length) throw new ValidationError("Content operation index is outside the document");
  const result = [];
  appendComponent(result, {retain: operation.index});
  if (operation.type === "insert") {
    appendComponent(result, {insert: operation.text ?? ""});
    appendComponent(result, {retain: length - operation.index});
  } else {
    if (operation.index + operation.count > length) throw new ValidationError("Content delete operation is outside the document");
    appendComponent(result, {delete: operation.count});
    appendComponent(result, {retain: length - operation.index - operation.count});
  }
  return result;
}

/** Compose base→middle with middle→result into base→result. */
export function composeTextOperations(first, second) {
  if (outputLength(first) !== inputLength(second)) throw new ValidationError("Collaborative text operations cannot be composed");
  const left = operationIterator(first);
  const right = operationIterator(second);
  const result = [];
  while (left.peek() || right.peek()) {
    const a = left.peek();
    const b = right.peek();
    if (a && componentType(a) === "delete") {
      appendComponent(result, a);
      left.consume(componentLength(a));
      continue;
    }
    if (b && componentType(b) === "insert") {
      appendComponent(result, b);
      right.consume(componentLength(b));
      continue;
    }
    if (!a || !b) throw new ValidationError("Collaborative text operation lengths do not match");
    const length = Math.min(componentLength(a), componentLength(b));
    const aType = componentType(a);
    const bType = componentType(b);
    if (aType === "retain" && bType === "retain") appendComponent(result, {retain: length});
    else if (aType === "insert" && bType === "retain") appendComponent(result, {insert: a.insert.slice(0, length)});
    else if (aType === "retain" && bType === "delete") appendComponent(result, {delete: length});
    else if (!(aType === "insert" && bType === "delete")) throw new ValidationError("Collaborative text operations cannot be composed");
    left.consume(length);
    right.consume(length);
  }
  return result;
}

/** Transform `operation` so it can be applied after `remote`. */
export function transformTextOperation(operation, remote, {operationKey = "", remoteKey = ""} = {}) {
  if (inputLength(operation) !== inputLength(remote)) throw new ValidationError("Collaborative text operations do not share a base");
  const left = operationIterator(operation);
  const right = operationIterator(remote);
  const transformed = [];
  const remoteTransformed = [];
  const operationHasPriority = String(operationKey).localeCompare(String(remoteKey)) < 0;
  while (left.peek() || right.peek()) {
    const a = left.peek();
    const b = right.peek();
    if (a && componentType(a) === "insert" && (!b || componentType(b) !== "insert" || operationHasPriority)) {
      appendComponent(transformed, a);
      appendComponent(remoteTransformed, {retain: componentLength(a)});
      left.consume(componentLength(a));
      continue;
    }
    if (b && componentType(b) === "insert") {
      appendComponent(transformed, {retain: componentLength(b)});
      appendComponent(remoteTransformed, b);
      right.consume(componentLength(b));
      continue;
    }
    if (!a || !b) throw new ValidationError("Collaborative text operation lengths do not match");
    const length = Math.min(componentLength(a), componentLength(b));
    const aType = componentType(a);
    const bType = componentType(b);
    if (aType === "retain" && bType === "retain") {
      appendComponent(transformed, {retain: length});
      appendComponent(remoteTransformed, {retain: length});
    } else if (aType === "delete" && bType === "retain") appendComponent(transformed, {delete: length});
    else if (aType === "retain" && bType === "delete") appendComponent(remoteTransformed, {delete: length});
    else if (!(aType === "delete" && bType === "delete")) throw new ValidationError("Collaborative text operations cannot be transformed");
    left.consume(length);
    right.consume(length);
  }
  return transformed;
}

export function applyTextOperation(text, operation) {
  if (inputLength(operation) !== text.length) throw new ValidationError("Collaborative text operation does not match the document");
  let offset = 0;
  let result = "";
  for (const component of operation) {
    const type = componentType(component);
    if (type === "retain") {
      result += text.slice(offset, offset + component.retain);
      offset += component.retain;
    } else if (type === "delete") offset += component.delete;
    else result += component.insert;
  }
  if (result.length > 100000) throw new ValidationError("Collaborative content must be at most 100,000 characters");
  return result;
}

export function clientOperationsToTextOperation(baseText, operations) {
  let operation = identity(baseText.length);
  let currentLength = baseText.length;
  for (const change of operations) {
    const primitive = primitiveOperation(currentLength, change);
    operation = composeTextOperations(operation, primitive);
    currentLength = outputLength(primitive);
  }
  return operation;
}

/** Derive one deterministic replacement operation for non-collaborative revisions. */
export function replacementTextOperation(previous, next) {
  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < previous.length - prefix && suffix < next.length - prefix && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix += 1;
  const operation = [];
  appendComponent(operation, {retain: prefix});
  appendComponent(operation, {delete: previous.length - prefix - suffix});
  appendComponent(operation, {insert: next.slice(prefix, next.length - suffix)});
  appendComponent(operation, {retain: suffix});
  return operation;
}

export function mergeContentOperations(current, revisions, input) {
  if (Number(input.version) > Number(current.version)) throw new ConflictError("Collaborative base version is ahead of the document");
  const collaborationKey = `${input.clientId}:${input.changeId}`;
  if (revisions.some((revision) => revision.collaborationKey === collaborationKey)) {
    return {duplicate: true, body: String(current.body ?? ""), collaborationKey};
  }
  if (Number(current.version) - Number(input.version) >= 100) throw new ConflictError("Collaborative history window expired; refresh before editing");
  const byVersion = new Map(revisions.map((revision) => [Number(revision.version), revision]));
  const base = Number(input.version) === Number(current.version) ? current : byVersion.get(Number(input.version));
  if (!base) throw new ConflictError("Collaborative base revision is no longer available; refresh before editing");
  let operation = clientOperationsToTextOperation(String(base.body ?? ""), input.operations);
  let previous = base;
  for (let version = Number(input.version) + 1; version <= Number(current.version); version += 1) {
    const revision = byVersion.get(version);
    if (!revision) throw new ConflictError("Collaborative revision history is incomplete; refresh before editing");
    const remote = revision.collaborationOperation ?? replacementTextOperation(String(previous.body ?? ""), String(revision.body ?? ""));
    operation = transformTextOperation(operation, remote, {
      operationKey: collaborationKey,
      remoteKey: revision.collaborationKey ?? `server:${String(version).padStart(10, "0")}`
    });
    previous = revision;
  }
  return {
    duplicate: false,
    body: applyTextOperation(String(current.body ?? ""), operation),
    operation,
    collaborationKey,
    merged: Number(input.version) !== Number(current.version),
    baseVersion: Number(input.version)
  };
}

// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import {
  assertWorkConfigurationUpdate,
  assertWorkItemConfiguration,
  assertWorkQueryConfiguration,
  ContractValidationError,
  defaultWorkConfiguration,
  parseDocumentFinalizeInput,
  parseDocumentUploadIntentInput,
  parsePortfolioPatchInput,
  parseWorkConfigurationInput,
  parseWorkItemInput,
  parseWorkItemPatchInput,
  parseWorkQuery,
  roles,
  workQueryVersion
} from "../src/index.js";

function editableDefaultWorkConfiguration() {
  return JSON.parse(JSON.stringify(defaultWorkConfiguration));
}

test("portfolio patches retain only mutable contract fields", () => {
  assert.deepEqual(parsePortfolioPatchInput({
    version: 3,
    name: "  Delivery  ",
    description: "  Updated portfolio  ",
    archived: true,
    PK: "SYSTEM#PUBLIC_DEMO",
    SK: "ACTIVE",
    id: "active",
    workspaceId: "another-workspace",
    createdAt: "attacker-controlled",
    updatedAt: "attacker-controlled",
    GSI1PK: "ATTACKER",
    GSI1SK: "ATTACKER"
  }), {
    version: 3,
    name: "Delivery",
    description: "Updated portfolio",
    archived: true
  });
  assert.throws(() => parsePortfolioPatchInput({name: "Missing version"}), /version is required/);
});

test("work item input accepts canonical planning fields", () => {
  const parsed = parseWorkItemInput({
    title: "Prepare review",
    type: "bug",
    status: "ready",
    effortPoints: 5,
    periodName: "Pilot Period",
    periodGoal: "Review outcome",
    intakeGroup: "ready",
    milestoneName: "Pilot beta"
  });
  assert.equal(parsed.type, "bug");
  assert.equal(parsed.effortPoints, 5);
  assert.equal(parsed.periodName, "Pilot Period");
  assert.equal(parsed.periodGoal, "Review outcome");
  assert.equal(parsed.intakeGroup, "ready");
  assert.equal(parsed.milestoneName, "Pilot beta");
  assert.equal(parseWorkItemInput({title: "Use configured defaults"}).type, undefined);
  assert.equal(parseWorkItemInput({title: "Custom", type: "user-story", status: "quality-review"}).status, "quality-review");
});

test("work item patches can clear planning fields", () => {
  assert.deepEqual(parseWorkItemPatchInput({
    version: 3,
    periodName: "",
    periodGoal: "",
    milestoneName: ""
  }), {
    version: 3,
    periodName: "",
    periodGoal: "",
    milestoneName: ""
  });
  assert.throws(() => parseWorkItemPatchInput({status: "done"}), /version is required/);
});

test("parses and versions bounded work queries", () => {
  const parsed = parseWorkQuery(new URLSearchParams({
    projectId: "project-pilot",
    type: "bug",
    status: "ready",
    assigneeId: "user-delivery-lead",
    dateFrom: "2026-07-01",
    dueTo: "2026-07-31",
    milestoneName: "Pilot beta",
    periodId: "period-1",
    search: "document",
    sort: "updated-desc",
    limit: "25",
    cursor: "opaque-cursor"
  }));
  assert.equal(parsed.version, workQueryVersion);
  assert.equal(parsed.projectId, "project-pilot");
  assert.equal(parsed.type, "bug");
  assert.equal(parsed.status, "ready");
  assert.equal(parsed.dueFrom, "2026-07-01");
  assert.equal(parsed.dueTo, "2026-07-31");
  assert.equal(parsed.limit, 25);
  assert.equal(parsed.cursor, "opaque-cursor");
});

test("work query defaults to a project-compatible sort and rejects invalid ranges", () => {
  assert.equal(parseWorkQuery({}, {projectId: "project-pilot"}).sort, "id-asc");
  assert.throws(
    () => parseWorkQuery({dueFrom: "2026-08-01", dueTo: "2026-07-01"}),
    (error) => error instanceof ContractValidationError && /must not be after/.test(error.message)
  );
  assert.throws(() => parseWorkQuery({sort: "due-asc"}), /requires assigneeId/);
  assert.equal(parseWorkQuery({type: "user-story"}).type, "user-story");
  assert.throws(() => parseWorkQuery({type: "Not a valid ID"}), /lowercase identifier/);
});

test("parses a bounded, referentially valid work configuration", () => {
  const input = editableDefaultWorkConfiguration();
  input.types.push({id: "user-story", label: "User story", active: true});
  input.statuses.push({id: "quality-review", label: "Quality review", active: true, closed: false});
  input.transitions.push({
    fromStatusId: "ready",
    toStatusId: "quality-review",
    roles: [roles.admin, roles.projectManager]
  });
  const parsed = parseWorkConfigurationInput(input);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.types.at(-1).id, "user-story");
  assert.equal(parsed.statuses.at(-1).id, "quality-review");
  assert.deepEqual(parsed.transitions.at(-1).roles, [roles.admin, roles.projectManager]);
});

test("rejects invalid work configuration IDs, references, defaults, and roles", () => {
  const duplicateType = editableDefaultWorkConfiguration();
  duplicateType.types.push({...duplicateType.types[0]});
  assert.throws(() => parseWorkConfigurationInput(duplicateType), /type IDs must be unique/);

  const unknownTarget = editableDefaultWorkConfiguration();
  unknownTarget.transitions[0].toStatusId = "missing-status";
  assert.throws(() => parseWorkConfigurationInput(unknownTarget), /known statuses/);

  const inactiveDefault = editableDefaultWorkConfiguration();
  inactiveDefault.types.find((item) => item.id === inactiveDefault.defaultTypeId).active = false;
  assert.throws(() => parseWorkConfigurationInput(inactiveDefault), /defaultTypeId must reference an active type/);

  const invalidRole = editableDefaultWorkConfiguration();
  invalidRole.transitions[0].roles = ["superuser"];
  assert.throws(() => parseWorkConfigurationInput(invalidRole), /not a known role/);

  const invalidId = editableDefaultWorkConfiguration();
  invalidId.statuses[0].id = "Needs Review";
  assert.throws(() => parseWorkConfigurationInput(invalidId), /lowercase identifier/);
});

test("preserves stable IDs and enforces active targets and role-aware transitions", () => {
  const next = parseWorkConfigurationInput(editableDefaultWorkConfiguration());
  const missingType = editableDefaultWorkConfiguration();
  missingType.types = missingType.types.slice(1);
  assert.throws(() => assertWorkConfigurationUpdate(next, missingType), /cannot be removed/);

  const restricted = editableDefaultWorkConfiguration();
  restricted.transitions = [{
    fromStatusId: "ready",
    toStatusId: "done",
    roles: [roles.projectManager]
  }];
  restricted.types.find((item) => item.id === "bug").active = false;
  const configuration = parseWorkConfigurationInput(restricted);

  assert.throws(() => assertWorkItemConfiguration(configuration, {
    type: "bug",
    status: "ready",
    creating: true,
    role: roles.projectManager
  }), /inactive/);
  assert.doesNotThrow(() => assertWorkItemConfiguration(configuration, {
    type: "bug",
    status: "ready",
    previousType: "bug",
    previousStatus: "ready",
    role: roles.member
  }));
  assert.throws(() => assertWorkItemConfiguration(configuration, {
    type: "task",
    status: "done",
    previousType: "task",
    previousStatus: "ready",
    role: roles.member
  }), /not allowed/);
  assert.doesNotThrow(() => assertWorkItemConfiguration(configuration, {
    type: "task",
    status: "done",
    previousType: "task",
    previousStatus: "ready",
    role: roles.projectManager
  }));
  assert.doesNotThrow(() => assertWorkQueryConfiguration(configuration, {type: "bug", status: "ready"}));
  assert.throws(() => assertWorkQueryConfiguration(configuration, {status: "not-a-status"}), /Expected one of/);
});

test("requires bounded upload metadata and a SHA-256 digest", () => {
  const checksumSha256 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const parsed = parseDocumentUploadIntentInput({
    projectId: "project-pilot",
    filename: "brief.pdf",
    contentType: "application/pdf",
    sizeBytes: 1024,
    checksumSha256
  });
  assert.equal(parsed.checksumSha256, checksumSha256);
  assert.throws(() => parseDocumentUploadIntentInput({
    projectId: "project-pilot",
    filename: "brief.pdf",
    contentType: "application/pdf",
    sizeBytes: 1024,
    checksumSha256: "not-a-digest"
  }), /base64-encoded SHA-256/);
  assert.throws(() => parseDocumentUploadIntentInput({
    projectId: "project-pilot",
    filename: "bad\nname.pdf",
    contentType: "application/pdf",
    sizeBytes: 1024,
    checksumSha256
  }), /control characters/);
  assert.throws(() => parseDocumentUploadIntentInput({
    projectId: "project-pilot",
    filename: "brief.pdf",
    contentType: "application/\u0000pdf",
    sizeBytes: 1024,
    checksumSha256
  }), /valid media type/);
  assert.throws(() => parseDocumentFinalizeInput({documentId: "document-one"}), /projectId/);
});

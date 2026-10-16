// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import {
  assertWorkConfigurationUpdate,
  assertWorkItemConfiguration,
  assertWorkQueryConfiguration,
  ContractValidationError,
  defaultWorkConfiguration,
  defaultWorkspaceCapabilities,
  parseDocumentFinalizeInput,
  parseDocumentUploadIntentInput,
  parsePortfolioPatchInput,
  parseMembershipInput,
  parseNotificationPreferencesInput,
  parseProjectInput,
  parseTimeEntryPatchInput,
  parseTimeEntryInput,
  parseTimerStartInput,
  parseWorkConfigurationInput,
  parseWorkItemInput,
  parseWorkItemPatchInput,
  parseWorkQuery,
  parseWorkspaceCapabilitiesInput,
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

test("project and task contracts expose parity lifecycle fields", () => {
  const project = parseProjectInput({
    name: "Child delivery",
    parentProjectId: "project-parent",
    modules: ["work", "meetings", "wiki"],
    template: true
  });
  assert.equal(project.parentProjectId, "project-parent");
  assert.deepEqual(project.modules, ["work", "meetings", "wiki"]);
  assert.equal(project.template, true);
  assert.throws(() => parseProjectInput({name: "Invalid", modules: ["work", "unknown"]}), /Expected one of/);

  const task = parseWorkItemInput({
    title: "Schedule rollout",
    accountableId: "user-owner",
    category: "Delivery",
    versionName: "1.0",
    remainingMinutes: 120,
    percentComplete: 25,
    schedulingMode: "automatic",
    relations: [{type: "predecessor", targetId: "work-one", lagDays: 2}]
  });
  assert.equal(task.accountableId, "user-owner");
  assert.equal(task.remainingMinutes, 120);
  assert.equal(task.percentComplete, 25);
  assert.equal(task.schedulingMode, "automatic");
  assert.deepEqual(task.relations, [{type: "predecessor", targetId: "work-one", lagDays: 2}]);
  assert.throws(() => parseWorkItemInput({title: "Invalid", relations: [{type: "unknown", targetId: "work-one"}]}), /Expected one of/);
});

test("work item patches can clear planning fields", () => {
  assert.deepEqual(parseWorkItemPatchInput({
    version: 3,
    periodName: "",
    periodGoal: "",
    milestoneName: "",
    parentId: "",
    assigneeId: "",
    startDate: "",
    dueDate: ""
  }), {
    version: 3,
    periodName: "",
    periodGoal: "",
    milestoneName: "",
    parentId: "",
    assigneeId: "",
    startDate: "",
    dueDate: ""
  });
  assert.throws(() => parseWorkItemPatchInput({status: "done"}), /version is required/);
});

test("time entry edits require stable addressing and optimistic versions", () => {
  assert.deepEqual(parseTimeEntryPatchInput({
    version: 2,
    originalEntryDate: "2026-08-20",
    entryDate: "2026-08-21",
    durationMinutes: 90,
    billable: true
  }), {
    version: 2,
    originalEntryDate: "2026-08-20",
    entryDate: "2026-08-21",
    durationMinutes: 90,
    billable: true
  });
  assert.throws(() => parseTimeEntryPatchInput({version: 1}), /originalEntryDate/);
});

test("custom fields cover every supported entity section and persistent timers", () => {
  const capabilities = JSON.parse(JSON.stringify(defaultWorkspaceCapabilities));
  capabilities.customFields = [
    {id: "work-text", name: "Work text", type: "long-text", entityType: "work-item"},
    {id: "project-link", name: "Project link", type: "link", entityType: "project"},
    {id: "user-flag", name: "User flag", type: "boolean", entityType: "user"},
    {id: "group-code", name: "Group code", type: "string", entityType: "group"},
    {id: "release-owner", name: "Release owner", type: "user", entityType: "version"},
    {id: "time-code", name: "Time code", type: "string", entityType: "time-entry"},
    {id: "activity-code", name: "Activity code", type: "integer", entityType: "time-entry-activity"},
    {id: "priority-score", name: "Priority score", type: "decimal", entityType: "priority"}
  ];
  assert.deepEqual(parseWorkspaceCapabilitiesInput(capabilities).customFields.map((field) => field.entityType), [
    "work-item", "project", "user", "group", "version", "time-entry", "time-entry-activity", "priority"
  ]);
  const longText = "x".repeat(5000);
  assert.equal(parseTimeEntryInput({projectId: "project-pilot", entryDate: "2026-08-27", durationMinutes: 30, customFields: {notes: longText}}).customFields.notes.length, 5000);
  assert.deepEqual(parseTimerStartInput({projectId: "project-pilot", activityId: "research", customFields: {"time-code": "R&D"}}), {
    projectId: "project-pilot",
    workItemId: undefined,
    description: "",
    billable: false,
    activityId: "research",
    customFields: {"time-code": "R&D"}
  });
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

test("validates versioned workspace capabilities without accepting embedded secrets", () => {
  const capabilities = JSON.parse(JSON.stringify(defaultWorkspaceCapabilities));
  capabilities.customFields.push({id: "business-value", name: "Business value", type: "weighted", entityType: "work-item", options: [{id: "high", weight: 8}]});
  capabilities.forms.push({id: "delivery-form", name: "Delivery form", typeIds: ["task"], fields: ["title", {id: "business-value", required: true, helpText: "Choose a weighted value"}]});
  capabilities.customRoles.push({id: "quality-reviewer", name: "Quality reviewer", permissions: ["workspace:read", "work:manage"]});
  capabilities.webhooks.push({id: "delivery-hook", name: "Delivery hook", url: "https://hooks.example.test/teamspaces", eventTypes: ["work.updated"]});
  capabilities.connectors.push({id: "managed-drive", name: "Managed drive", type: "sharepoint", baseUrl: "https://graph.microsoft.test", credentialReference: "graph-main", driveId: "drive-one", managedPermissions: true, managedPermissionDomains: ["example.test"], managedResources: [{projectId: "project-pilot", resourceId: "folder-one"}]});
  const parsed = parseWorkspaceCapabilitiesInput(capabilities);
  assert.equal(parsed.customFields[0].type, "weighted");
  assert.equal(parsed.forms[0].fields[1].id, "business-value");
  assert.equal(parsed.customRoles[0].permissions.includes("work:manage"), true);
  assert.equal(parsed.connectors[0].managedResources[0].resourceId, "folder-one");
  assert.equal(parseMembershipInput({email: "reviewer@example.test", role: "custom:quality-reviewer"}).role, "custom:quality-reviewer");
  const withSecret = JSON.parse(JSON.stringify(defaultWorkspaceCapabilities));
  withSecret.authentication.ldap.password = "do-not-store";
  assert.throws(() => parseWorkspaceCapabilitiesInput(withSecret), /credential reference/);
  const privateWebhook = JSON.parse(JSON.stringify(defaultWorkspaceCapabilities));
  privateWebhook.webhooks.push({id: "private-hook", name: "Private", url: "https://127.0.0.1/events", eventTypes: ["*"]});
  assert.throws(() => parseWorkspaceCapabilitiesInput(privateWebhook), /public HTTPS/);
  const unknownFormField = JSON.parse(JSON.stringify(defaultWorkspaceCapabilities));
  unknownFormField.forms.push({id: "invalid-form", name: "Invalid", fields: ["not-a-real-field"]});
  assert.throws(() => parseWorkspaceCapabilitiesInput(unknownFormField), /unknown field/);
  const invalidManagedResource = JSON.parse(JSON.stringify(defaultWorkspaceCapabilities));
  invalidManagedResource.connectors.push({id: "managed-drive", name: "Managed drive", type: "sharepoint", baseUrl: "https://graph.microsoft.test", credentialReference: "graph-main", managedResources: [{projectId: "project-pilot"}]});
  assert.throws(() => parseWorkspaceCapabilitiesInput(invalidManagedResource), /managedResources/);
});

test("derives duration from exact start and end timestamps", () => {
  const parsed = parseTimeEntryInput({
    projectId: "project-pilot",
    entryDate: "2026-08-26",
    startedAt: "2026-08-26T13:00:00Z",
    endedAt: "2026-08-26T14:15:00Z"
  });
  assert.equal(parsed.durationMinutes, 75);
  assert.equal(parsed.startedAt, "2026-08-26T13:00:00.000Z");
});

test("validates versioned per-user notification preferences", () => {
  assert.deepEqual(parseNotificationPreferencesInput({
    version: 4,
    participationRules: ["assigned", "watching"],
    projectOverrides: [{projectId: "project-pilot", participationRules: ["accountable"]}],
    dateAlertsEnabled: false,
    emailDigest: "weekly",
    deliveryWebhookId: "mail-gateway",
    digestHourUtc: 14,
    weeklyDay: 5
  }), {
    version: 4,
    participationRules: ["assigned", "watching"],
    projectOverrides: [{projectId: "project-pilot", participationRules: ["accountable"]}],
    dateAlertsEnabled: false,
    emailDigest: "weekly",
    deliveryWebhookId: "mail-gateway",
    digestHourUtc: 14,
    weeklyDay: 5
  });
  assert.throws(() => parseNotificationPreferencesInput({version: 1, participationRules: [], projectOverrides: [], emailDigest: "daily", digestHourUtc: 8, weeklyDay: 1}), /delivery webhook/);
  assert.throws(() => parseNotificationPreferencesInput({version: 1, participationRules: ["everything"], projectOverrides: [], emailDigest: "none", digestHourUtc: 8, weeklyDay: 1}), /unsupported rule/);
  assert.throws(() => parseNotificationPreferencesInput({version: 1, participationRules: [], projectOverrides: [], emailDigest: "none", digestHourUtc: 24, weeklyDay: 1}), /digestHourUtc/);
});

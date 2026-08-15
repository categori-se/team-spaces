// @ts-nocheck

import {defaultWorkConfiguration, roles} from "@teamspaces/contracts";

export const publicDemoPathPrefix = "/api/v1/demo";
export const publicDemoPointerKey = Object.freeze({PK: "SYSTEM#PUBLIC_DEMO", SK: "ACTIVE"});
export const publicDemoSlots = Object.freeze(["a", "b"]);
export const publicDemoBodyLimitBytes = 8 * 1024;
export const publicDemoPageLimit = 10;
export const publicDemoResponseLimitBytes = 32 * 1024;
export const publicDemoStringLimit = 1024;
export const publicDemoMutationLimit = 500;

export const publicDemoEntityLimits = Object.freeze({
  portfolio: 5,
  project: 5,
  workItem: 50,
  meeting: 20,
  timeEntry: 50,
  comment: 50,
  savedView: 15
});

const dayMs = 24 * 60 * 60 * 1000;

/** @param {string} slot */
export function assertPublicDemoSlot(slot) {
  if (!publicDemoSlots.includes(slot)) throw new Error("Public demo slot must be a or b");
  return slot;
}

/** @param {string} slot */
export function publicDemoWorkspaceId(slot) {
  return `public-demo-${assertPublicDemoSlot(slot)}`;
}

/** @param {string} slot @param {string} key */
export function publicDemoUserId(slot, key) {
  return `${publicDemoWorkspaceId(slot)}-user-${key}`;
}

/** @param {string} slot @param {string} key */
export function publicDemoProjectId(slot, key) {
  return `${publicDemoWorkspaceId(slot)}-project-${key}`;
}

/** @param {string} slot */
export function publicDemoProjectIdPrefix(slot) {
  return `${publicDemoWorkspaceId(slot)}-project-`;
}

/** @param {string} slot */
export function publicDemoIdentity(slot) {
  return {
    id: publicDemoUserId(slot, "visitor"),
    email: "visitor@demo.example",
    name: "Demo Visitor"
  };
}

/** @param {Date} date @param {number} offset */
function dateOnly(date, offset) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) + offset * dayMs)
    .toISOString()
    .slice(0, 10);
}

/** @param {Date} date @param {number} offset @param {number} hour @param {number} minute */
function timestamp(date, offset, hour = 14, minute = 0) {
  const shifted = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute) + offset * dayMs);
  return shifted.toISOString();
}

/** @param {Date} now @param {number} resetHourUtc */
export function nextPublicDemoResetAt(now, resetHourUtc = 5) {
  const candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), resetHourUtc));
  if (candidate <= now) candidate.setUTCDate(candidate.getUTCDate() + 1);
  return candidate.toISOString();
}

/**
 * Identify the reset cycle containing a timestamp. A cycle starts at the
 * configured UTC reset hour rather than at midnight, so an initial deployment
 * before that hour cannot accidentally suppress the upcoming daily reset.
 *
 * @param {Date} now
 * @param {number} resetHourUtc
 */
export function publicDemoResetCycleDate(now, resetHourUtc = 5) {
  const boundary = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), resetHourUtc));
  if (now < boundary) boundary.setUTCDate(boundary.getUTCDate() - 1);
  return boundary.toISOString().slice(0, 10);
}

/**
 * One realistic, entirely fictional workspace. IDs are namespaced to the
 * inactive slot so reset can prepare a complete replacement before exposing
 * it to visitors.
 *
 * @param {string} slot
 * @param {Date | string} [clock]
 */
export function createPublicDemoSeed(slot, clock = new Date()) {
  assertPublicDemoSlot(slot);
  const now = clock instanceof Date ? new Date(clock) : new Date(clock);
  if (Number.isNaN(now.getTime())) throw new Error("Public demo seed clock is invalid");
  const createdAt = timestamp(now, -28, 13);
  const updatedAt = now.toISOString();
  const workspaceId = publicDemoWorkspaceId(slot);
  const visitor = publicDemoIdentity(slot);
  const mina = {id: publicDemoUserId(slot, "mina"), email: "mina.rao@demo.example", name: "Mina Rao"};
  const jordan = {id: publicDemoUserId(slot, "jordan"), email: "jordan.lee@demo.example", name: "Jordan Lee"};
  const avery = {id: publicDemoUserId(slot, "avery"), email: "avery.chen@demo.example", name: "Avery Chen"};
  const sam = {id: publicDemoUserId(slot, "sam"), email: "sam.okafor@demo.example", name: "Sam Okafor"};
  const users = [visitor, mina, jordan, avery, sam];
  const workspace = {
    id: workspaceId,
    name: "Team Spaces Demo",
    accountType: "team",
    defaultProjectPrefix: "DEMO",
    dataRetentionDays: 1,
    version: 1,
    createdBy: visitor.id,
    createdAt,
    updatedAt
  };
  const memberships = [
    {...visitor, workspaceId, userId: visitor.id, role: roles.admin, status: "active", defaultAccount: true, title: "Demo visitor"},
    {...mina, workspaceId, userId: mina.id, role: roles.projectManager, status: "active", title: "Delivery lead"},
    {...jordan, workspaceId, userId: jordan.id, role: roles.member, status: "active", title: "Product engineer"},
    {...avery, workspaceId, userId: avery.id, role: roles.member, status: "active", title: "Product designer"},
    {...sam, workspaceId, userId: sam.id, role: roles.viewer, status: "active", title: "Executive sponsor"}
  ].map((membership) => ({...membership, version: 1, createdAt, updatedAt}));

  const portfolioProduct = `public-demo-${slot}-portfolio-product`;
  const portfolioOperations = `public-demo-${slot}-portfolio-operations`;
  const portfolios = [
    {
      id: portfolioProduct,
      workspaceId,
      name: "Product & Growth",
      description: "Customer-facing launches and product improvements.",
      archived: false,
      version: 1,
      createdAt,
      updatedAt
    },
    {
      id: portfolioOperations,
      workspaceId,
      name: "Operations",
      description: "Security, reliability, and internal readiness work.",
      archived: false,
      version: 1,
      createdAt,
      updatedAt
    }
  ];

  const launchId = publicDemoProjectId(slot, "customer-portal");
  const onboardingId = publicDemoProjectId(slot, "mobile-onboarding");
  const complianceId = publicDemoProjectId(slot, "soc2-readiness");
  memberships.find((membership) => membership.userId === mina.id).projectIds = [launchId, onboardingId, complianceId];
  memberships.find((membership) => membership.userId === jordan.id).projectIds = [launchId, onboardingId, complianceId];
  memberships.find((membership) => membership.userId === avery.id).projectIds = [launchId, onboardingId];
  memberships.find((membership) => membership.userId === sam.id).projectIds = [launchId, complianceId];
  const projects = [
    {
      id: launchId,
      workspaceId,
      portfolioId: portfolioProduct,
      name: "Customer portal launch",
      description: "Launch a self-service customer portal with account, billing, and support workflows.",
      ownerId: mina.id,
      status: "active",
      health: "watch",
      priority: "high",
      phase: "Execution",
      startDate: dateOnly(now, -35),
      targetDate: dateOnly(now, 18),
      percentComplete: 64,
      archived: false,
      favorite: true,
      tags: ["launch", "customer"],
      version: 1,
      createdAt,
      updatedAt
    },
    {
      id: onboardingId,
      workspaceId,
      portfolioId: portfolioProduct,
      name: "Mobile onboarding refresh",
      description: "Reduce first-session friction and improve activation on mobile.",
      ownerId: avery.id,
      status: "active",
      health: "on-track",
      priority: "high",
      phase: "Execution",
      startDate: dateOnly(now, -18),
      targetDate: dateOnly(now, 32),
      percentComplete: 38,
      archived: false,
      favorite: true,
      tags: ["mobile", "activation"],
      version: 1,
      createdAt,
      updatedAt
    },
    {
      id: complianceId,
      workspaceId,
      portfolioId: portfolioOperations,
      name: "SOC 2 readiness",
      description: "Close evidence gaps and prepare control owners for the readiness review.",
      ownerId: jordan.id,
      status: "active",
      health: "at-risk",
      priority: "critical",
      phase: "Execution",
      startDate: dateOnly(now, -52),
      targetDate: dateOnly(now, 12),
      percentComplete: 72,
      archived: false,
      favorite: false,
      tags: ["security", "compliance"],
      version: 1,
      createdAt,
      updatedAt
    }
  ];

  const projectByKey = {launch: launchId, onboarding: onboardingId, compliance: complianceId};
  const userByKey = {visitor: visitor.id, mina: mina.id, jordan: jordan.id, avery: avery.id, sam: sam.id};
  const taskSpecs = [
    ["portal-navigation", "launch", "Finalize portal navigation", "feature", "intake", "medium", "avery", 3, 14, "Experience", "Launch v1"],
    ["billing-copy", "launch", "Review billing and invoice copy", "task", "ready", "medium", "sam", 2, 8, "Launch sprint", "Launch v1"],
    ["account-api", "launch", "Connect account summary API", "feature", "in-progress", "high", "jordan", 8, 5, "Launch sprint", "Launch v1"],
    ["support-routing", "launch", "Resolve support routing dependency", "bug", "blocked", "critical", "mina", 5, 3, "Launch sprint", "Launch v1"],
    ["design-signoff", "launch", "Approve responsive visual design", "milestone", "done", "high", "avery", 3, -3, "Launch sprint", "Launch v1"],
    ["welcome-research", "onboarding", "Synthesize welcome-flow interviews", "task", "done", "medium", "avery", 3, -7, "Discovery", "Activation beta"],
    ["progressive-profile", "onboarding", "Prototype progressive profile setup", "feature", "in-progress", "high", "avery", 5, 9, "Activation sprint", "Activation beta"],
    ["analytics-events", "onboarding", "Define activation analytics events", "task", "ready", "medium", "jordan", 3, 12, "Activation sprint", "Activation beta"],
    ["accessibility-pass", "onboarding", "Run onboarding accessibility pass", "task", "intake", "medium", "visitor", 2, 19, "Activation sprint", "Activation beta"],
    ["experiment-plan", "onboarding", "Draft onboarding experiment plan", "task", "ready", "medium", "mina", 2, 16, "Activation sprint", "Activation beta"],
    ["vendor-evidence", "compliance", "Collect vendor management evidence", "task", "in-progress", "high", "mina", 5, 4, "Readiness review", "Audit ready"],
    ["access-review", "compliance", "Complete quarterly access review", "task", "done", "high", "jordan", 5, -2, "Readiness review", "Audit ready"],
    ["retention-gap", "compliance", "Close log-retention evidence gap", "risk", "blocked", "critical", "jordan", 8, 2, "Readiness review", "Audit ready"],
    ["policy-ack", "compliance", "Gather policy acknowledgements", "task", "ready", "low", "sam", 1, 10, "Readiness review", "Audit ready"],
    ["tabletop", "compliance", "Schedule incident response tabletop", "milestone", "intake", "high", "visitor", 3, 21, "Assurance", "Audit ready"]
  ];
  const workItems = taskSpecs.map((spec, index) => {
    const [key, projectKey, title, type, status, priority, assigneeKey, effortPoints, dueOffset, periodName, milestoneName] = spec;
    const id = `public-demo-${slot}-work-${key}`;
    const dueDays = Number(dueOffset);
    if (!Number.isFinite(dueDays)) throw new Error(`Public demo task ${key} has an invalid due-date offset`);
    return {
      id,
      projectId: projectByKey[projectKey],
      workspaceId,
      type,
      title,
      description: `${title} with enough context for a visitor to explore task details, ownership, dates, and workflow changes.`,
      status,
      priority,
      assigneeId: userByKey[assigneeKey],
      reporterId: mina.id,
      startDate: dateOnly(now, Math.min(-7, dueDays - 10)),
      dueDate: dateOnly(now, dueDays),
      estimateMinutes: Number(effortPoints) * 60,
      recordedMinutes: status === "done" ? Number(effortPoints) * 55 : status === "in-progress" ? Number(effortPoints) * 20 : 0,
      effortPoints,
      periodId: `public-demo-${slot}-period-${String(periodName).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      periodName,
      periodGoal: periodName === "Readiness review" ? "Close the evidence gaps that could delay the audit." : "Move the highest-value work to a clear outcome.",
      intakeGroup: status === "blocked" ? "bugs" : status === "intake" ? "ideas" : "ready",
      milestoneName,
      blockedBy: status === "blocked" ? [`public-demo-${slot}-work-${projectKey === "launch" ? "account-api" : "vendor-evidence"}`] : [],
      relatedIds: [],
      watcherIds: [mina.id, sam.id].filter((id) => id !== userByKey[assigneeKey]),
      acceptanceCriteria: `The team can review ${String(title).toLowerCase()} and agree that the expected outcome is complete.`,
      customFields: {team: projectKey === "compliance" ? "Security" : "Product", confidence: status === "blocked" ? "Low" : "High"},
      rank: (index + 1) * 10,
      tags: [projectKey, type],
      version: 1,
      createdAt,
      updatedAt: timestamp(now, -1 - Math.floor(index / 3), 12 + (index % 3))
    };
  });

  const workId = (key) => `public-demo-${slot}-work-${key}`;
  const meetings = [
    {
      id: `public-demo-${slot}-meeting-launch-review`,
      workspaceId,
      projectId: launchId,
      title: "Customer portal launch review",
      description: "Review launch risks, ownership, and the final acceptance path.",
      startsAt: timestamp(now, 2, 15),
      endsAt: timestamp(now, 2, 16),
      status: "open",
      location: "Zoom · Product room",
      participantIds: [visitor.id, mina.id, jordan.id, avery.id, sam.id],
      agendaItems: [
        {id: "launch-risk", title: "Launch risks", durationMinutes: 20, presenterId: mina.id, workItemIds: [workId("support-routing")], notes: "Confirm owner and contingency.", outcome: ""},
        {id: "launch-readiness", title: "Readiness checklist", durationMinutes: 25, presenterId: jordan.id, workItemIds: [workId("account-api")], notes: "Review remaining integration work.", outcome: ""}
      ],
      minutes: "",
      version: 1,
      createdBy: mina.id,
      updatedBy: mina.id,
      createdAt,
      updatedAt
    },
    {
      id: `public-demo-${slot}-meeting-activation-standup`,
      workspaceId,
      projectId: onboardingId,
      title: "Activation design decision review",
      description: "Record the design decisions that made the next onboarding experiment ready for engineering.",
      startsAt: timestamp(now, -1, 14),
      endsAt: timestamp(now, -1, 14, 45),
      status: "closed",
      location: "Design studio",
      participantIds: [visitor.id, mina.id, jordan.id, avery.id],
      agendaItems: [
        {id: "prototype", title: "Prototype decision", durationMinutes: 20, presenterId: avery.id, workItemIds: [workId("progressive-profile")], notes: "Compare the progressive and single-page variants against the first-session goal.", outcome: "Proceed with the simplified progressive-profile variant. Avery owns the final interaction pass."},
        {id: "measurement", title: "Measurement and experiment plan", durationMinutes: 15, presenterId: jordan.id, workItemIds: [workId("analytics-events"), workId("experiment-plan")], notes: "Agree on the activation event and the smallest useful experiment cohort.", outcome: "Track profile completion and first key action. Jordan will define events; Mina will finish the experiment plan."},
        {id: "guardrails", title: "Launch guardrails", durationMinutes: 10, presenterId: visitor.id, workItemIds: [workId("accessibility-pass")], notes: "Confirm what must be true before the beta starts.", outcome: "Accessibility review is a launch requirement, not a post-launch follow-up."}
      ],
      minutes: "Decision: use the simplified progressive-profile flow. Avery will refine the interaction, Jordan will define activation events, Mina will publish the experiment plan, and the Demo Visitor will complete the accessibility pass before beta. The team will review results at the next activation stand-up.",
      version: 1,
      createdBy: avery.id,
      updatedBy: avery.id,
      createdAt,
      updatedAt
    },
    {
      id: `public-demo-${slot}-meeting-access-retro`,
      workspaceId,
      projectId: complianceId,
      title: "Quarterly access review retrospective",
      description: "Capture what to improve before the next evidence cycle.",
      startsAt: timestamp(now, -4, 14),
      endsAt: timestamp(now, -4, 15),
      status: "closed",
      location: "Security room",
      participantIds: [visitor.id, mina.id, jordan.id, sam.id],
      agendaItems: [
        {id: "access-outcome", title: "Evidence outcome", durationMinutes: 30, presenterId: jordan.id, workItemIds: [workId("access-review")], notes: "Review exceptions and evidence links.", outcome: "All exceptions have named owners."}
      ],
      minutes: "The access review closed on time. The team will automate reviewer reminders next quarter.",
      version: 1,
      createdBy: jordan.id,
      updatedBy: jordan.id,
      createdAt,
      updatedAt: timestamp(now, -4, 15)
    }
  ];

  const documents = [
    ["launch-brief", launchId, workId("portal-navigation"), "Customer portal launch brief", "launch-brief.pdf", "application/pdf", "brief", "Scope, audience, launch measures, and open risks.", "LAUNCH BRIEF\nGoal: customers can find account, billing, and support tasks without assistance.\nSuccess: 80% task completion in usability review.\nOpen risk: support routing needs a confirmed owner before release."],
    ["onboarding-design", onboardingId, workId("progressive-profile"), "Onboarding design review", "onboarding-review.fig", "application/octet-stream", "design", "Annotated design decisions for the activation flow.", "DESIGN REVIEW\nDecision: use progressive profile setup with two short steps.\nKeep: clear progress, skip option, and a single primary action.\nFollow-up: validate focus order and reduced-motion behavior."],
    ["access-evidence", complianceId, workId("access-review"), "Quarterly access review evidence", "access-review.csv", "text/csv", "evidence", "Fictional review evidence used to demonstrate document metadata.", "control,owner,status\nQuarterly access review,Jordan,Complete\nException ownership,Mina,Complete\nReviewer reminders,Demo Visitor,Planned"],
    ["retention-decision", complianceId, workId("retention-gap"), "Log retention decision", "retention-decision.md", "text/markdown", "decision", "Decision record for the remaining retention gap.", "DECISION RECORD\nStatus: Accepted\nDecision: retain application audit logs for the policy window and verify lifecycle deletion monthly.\nOwner: Jordan Lee\nNext check: readiness review." ]
  ].map(([key, projectId, workItemId, name, filename, contentType, category, description, samplePreview], index) => ({
    id: `public-demo-${slot}-document-${key}`,
    workspaceId,
    projectId,
    workItemId,
    name,
    filename,
    contentType,
    sizeBytes: 2048 + index * 768,
    category,
    description,
    sampleOnly: true,
    samplePreview,
    tags: ["demo", category],
    status: index === 3 ? "archived" : "ready",
    uploadedBy: index % 2 ? avery.id : mina.id,
    version: 1,
    createdAt,
    updatedAt: timestamp(now, -1 - index, 11)
  }));

  const timeSpecs = [
    [visitor.id, launchId, workId("portal-navigation"), -1, 45, "Reviewed the launch board"],
    [visitor.id, onboardingId, workId("accessibility-pass"), 0, 30, "Outlined accessibility checks"],
    [mina.id, launchId, workId("support-routing"), -2, 90, "Coordinated support dependency"],
    [jordan.id, launchId, workId("account-api"), -1, 180, "Implemented account summary integration"],
    [avery.id, onboardingId, workId("progressive-profile"), -1, 120, "Refined onboarding prototype"],
    [jordan.id, complianceId, workId("retention-gap"), -3, 75, "Reviewed retention evidence"],
    [sam.id, complianceId, workId("policy-ack"), -2, 30, "Reviewed policy acknowledgements"]
  ];
  const timeEntries = timeSpecs.map(([userId, projectId, workItemId, dayOffset, durationMinutes, description], index) => ({
    id: `public-demo-${slot}-time-${index + 1}`,
    workspaceId,
    userId,
    projectId,
    workItemId,
    entryDate: dateOnly(now, Number(dayOffset)),
    durationMinutes,
    description,
    billable: false,
    version: 1,
    createdAt,
    updatedAt
  }));

  const savedViews = [
    {
      id: `public-demo-${slot}-view-my-urgent-work`,
      userId: visitor.id,
      workspaceId,
      name: "My urgent work",
      scope: "planning",
      filters: {scope: "mine", priority: "high", layout: "list"},
      version: 1,
      createdAt,
      updatedAt
    },
    {
      id: `public-demo-${slot}-view-launch-board`,
      userId: visitor.id,
      workspaceId,
      name: "Launch board",
      scope: `planning:${launchId}`,
      filters: {projectId: launchId, layout: "board", boardBy: "status", scope: "all"},
      version: 1,
      createdAt,
      updatedAt
    }
  ];

  const activitySpecs = [
    [launchId, mina.id, "project", launchId, "project.updated", "Updated customer portal health to Watch", ["health"]],
    [launchId, jordan.id, "work-item", workId("account-api"), "work.updated", "Moved Connect account summary API to In progress", ["status"]],
    [launchId, avery.id, "work-item", workId("design-signoff"), "work.updated", "Completed responsive visual design", ["status"]],
    [onboardingId, avery.id, "work-item", workId("progressive-profile"), "work.updated", "Added the simplified profile prototype", ["description"]],
    [onboardingId, mina.id, "project", onboardingId, "comment.created", "Activation experiment is ready for sizing", ["summary"]],
    [onboardingId, avery.id, "meeting", meetings[1].id, "meeting.updated", "Captured three activation decisions and assigned four linked follow-ups", ["agendaItems", "minutes"]],
    [onboardingId, visitor.id, "time-entry", timeEntries[1].id, "time.created", "Recorded 30 minutes for the onboarding accessibility plan", ["durationMinutes", "description"]],
    [complianceId, jordan.id, "work-item", workId("access-review"), "work.updated", "Completed quarterly access review", ["status"]],
    [complianceId, mina.id, "work-item", workId("retention-gap"), "work.updated", "Flagged the log-retention evidence gap", ["status", "priority"]],
    [complianceId, sam.id, "document", documents[2].id, "document.updated", "Reviewed quarterly access evidence", ["status"]],
    [undefined, visitor.id, "saved-view", savedViews[0].id, "saved-view.created", "Created My urgent work view", ["name", "filters"]],
    [undefined, visitor.id, "workspace", workspaceId, "workspace.seeded", "Restored the shared demo workspace", []]
  ];
  const activities = activitySpecs.map(([projectId, actorId, entityType, entityId, eventType, summary, changedFields], index) => ({
    id: `public-demo-${slot}-activity-${index + 1}`,
    workspaceId,
    projectId,
    actorId,
    timestamp: timestamp(now, -1 - Math.floor(index / 2), 17 - (index % 4)),
    entityType,
    entityId,
    eventType,
    changedFields,
    summary,
    correlationId: `public-demo-seed-${slot}`
  }));

  return {
    workspace,
    users,
    memberships,
    portfolios,
    projects,
    workConfigurations: [{...structuredClone(defaultWorkConfiguration), workspaceId}],
    workItems,
    meetings,
    documents,
    timeEntries,
    savedViews,
    activities
  };
}

/** @param {string} path */
export function stripPublicDemoPrefix(path) {
  if (path === publicDemoPathPrefix) return "/";
  return path.startsWith(`${publicDemoPathPrefix}/`) ? path.slice(publicDemoPathPrefix.length) : path;
}

const readRoutes = [
  /^\/health$/,
  /^\/bootstrap$/,
  /^\/me$/,
  /^\/accounts$/,
  /^\/workspace$/,
  /^\/work-configuration$/,
  /^\/memberships$/,
  /^\/portfolios(?:\/[^/]+)?$/,
  /^\/projects(?:\/[^/]+)?$/,
  /^\/projects\/[^/]+\/work-items$/,
  /^\/work-items\/assigned$/,
  /^\/planning$/,
  /^\/meetings(?:\/[^/]+)?$/,
  /^\/time-entries$/,
  /^\/activity$/,
  /^\/documents$/,
  /^\/saved-views$/,
  /^\/reports\/(?:portfolio-summary|planning-summary|project-timeline)$/,
  /^\/application-data\/summary$/
];

const mutationRoutes = [
  {method: "PATCH", pattern: /^\/work-configuration$/, kind: "workConfiguration"},
  {method: "POST", pattern: /^\/portfolios$/, kind: "portfolio", cap: publicDemoEntityLimits.portfolio},
  {method: "PATCH", pattern: /^\/portfolios\/[^/]+$/, kind: "portfolio"},
  {method: "POST", pattern: /^\/projects$/, kind: "project", cap: publicDemoEntityLimits.project},
  {method: "PATCH", pattern: /^\/projects\/[^/]+$/, kind: "project"},
  {method: "POST", pattern: /^\/projects\/[^/]+\/work-items$/, kind: "workItem", cap: publicDemoEntityLimits.workItem},
  {method: "PATCH", pattern: /^\/projects\/[^/]+\/work-items\/[^/]+$/, kind: "workItem"},
  {method: "POST", pattern: /^\/meetings$/, kind: "meeting", cap: publicDemoEntityLimits.meeting},
  {method: "PATCH", pattern: /^\/meetings\/[^/]+$/, kind: "meeting"},
  {method: "POST", pattern: /^\/time-entries$/, kind: "timeEntry", cap: publicDemoEntityLimits.timeEntry},
  {method: "POST", pattern: /^\/activity$/, kind: "comment", cap: publicDemoEntityLimits.comment},
  {method: "POST", pattern: /^\/saved-views$/, kind: "savedView", cap: publicDemoEntityLimits.savedView},
  {method: "PATCH", pattern: /^\/documents\/[^/]+$/, kind: "document"}
];

/**
 * The public surface is deliberately explicit. A newly added application
 * endpoint is private until it is reviewed and added here.
 *
 * @param {string} method
 * @param {string} rawPath
 */
export function publicDemoRequestPolicy(method, rawPath) {
  if (rawPath !== publicDemoPathPrefix && !rawPath.startsWith(`${publicDemoPathPrefix}/`)) {
    return {allowed: false, mutation: false};
  }
  const path = stripPublicDemoPrefix(rawPath);
  if (method === "GET" && readRoutes.some((pattern) => pattern.test(path))) {
    return {allowed: true, mutation: false, path};
  }
  const mutation = mutationRoutes.find((candidate) => candidate.method === method && candidate.pattern.test(path));
  return mutation
    ? {allowed: true, mutation: true, path, kind: mutation.kind, cap: mutation.cap}
    : {allowed: false, mutation: ["POST", "PUT", "PATCH", "DELETE"].includes(method), path};
}

/**
 * Anonymous demo input is intentionally narrower than the authenticated
 * product contract. This keeps one visitor from turning small editable
 * records into a persistent response-transfer amplifier for everyone else.
 *
 * @param {unknown} value
 * @param {number} [depth]
 */
export function assertPublicDemoPayload(value, depth = 0) {
  if (depth > 16) throw new Error("Shared demo content must not be nested more than 16 levels");
  if (typeof value === "string" && value.length > publicDemoStringLimit) {
    throw new Error(`Shared demo text fields must not exceed ${publicDemoStringLimit} characters`);
  }
  if (Array.isArray(value)) {
    for (const item of value) assertPublicDemoPayload(item, depth + 1);
    return value;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) assertPublicDemoPayload(item, depth + 1);
  }
  return value;
}

/** @param {any} active @param {Date} [now] */
export function publicDemoMetadata(active, now = new Date()) {
  const resetHour = Number(process.env.PUBLIC_DEMO_RESET_HOUR_UTC ?? 5);
  return {
    enabled: true,
    shared: true,
    editable: true,
    resetAt: active.resetAt,
    nextResetAt: active.nextResetAt ?? nextPublicDemoResetAt(now, resetHour),
    resetSchedule: "daily",
    seedVersion: active.seedVersion,
    mutationLimit: Number(process.env.PUBLIC_DEMO_MUTATION_LIMIT ?? publicDemoMutationLimit),
    notice: "Changes are shared with other visitors and reset daily. Editing may pause if the shared daily request limit is reached. Do not enter sensitive information."
  };
}

export class MemoryPublicDemoControl {
  /** @param {{slot?: string, now?: Date | string, seedVersion?: string, mutationLimit?: number}} [options] */
  constructor(options = {}) {
    const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
    const slot = options.slot ?? "a";
    this.pointer = {
      activeSlot: assertPublicDemoSlot(slot),
      workspaceId: publicDemoWorkspaceId(slot),
      resetAt: now.toISOString(),
      nextResetAt: nextPublicDemoResetAt(now),
      resetDate: publicDemoResetCycleDate(now),
      seedVersion: options.seedVersion ?? "1",
      version: 1
    };
    this.mutationLimit = options.mutationLimit ?? publicDemoMutationLimit;
    this.usage = new Map();
  }

  async getActive() {
    return structuredClone(this.pointer);
  }

  /** @param {{kind?: string, cap?: number}} policy */
  async claimMutation(policy = {}, active = this.pointer) {
    const date = active.resetDate ?? new Date().toISOString().slice(0, 10);
    const usage = this.usage.get(date) ?? {total: 0, kinds: {}};
    if (usage.total >= this.mutationLimit) return false;
    const kind = policy.kind ?? "other";
    if (policy.cap !== undefined && Number(usage.kinds[kind] ?? 0) >= policy.cap) return false;
    usage.total += 1;
    if (policy.cap !== undefined) usage.kinds[kind] = Number(usage.kinds[kind] ?? 0) + 1;
    this.usage.set(date, usage);
    return true;
  }
}

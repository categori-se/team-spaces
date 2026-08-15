// @ts-check

import {roles} from "@teamspaces/contracts";

export const fixedNow = "2026-07-10T12:00:00.000Z";

export const demoUser = Object.freeze({
  id: "user-demo-admin",
  email: "admin@team-spaces.example",
  name: "Demo Admin"
});

export const deliveryLead = Object.freeze({
  id: "user-delivery-lead",
  email: "delivery@team-spaces.example",
  name: "Mina Rao"
});

export const productEngineer = Object.freeze({
  id: "user-product-engineer",
  email: "engineer@team-spaces.example",
  name: "Jordan Lee"
});

export const designLead = Object.freeze({
  id: "user-design-lead",
  email: "design@team-spaces.example",
  name: "Avery Chen"
});

export const demoWorkspace = Object.freeze({
  id: "workspace-default",
  name: "Team Spaces Pilot",
  accountType: "team"
});

export const demoMembership = Object.freeze({
  workspaceId: demoWorkspace.id,
  userId: demoUser.id,
  role: roles.admin,
  email: demoUser.email,
  name: demoUser.name,
  status: "active",
  defaultAccount: true
});

export const seedData = Object.freeze({
  workspace: demoWorkspace,
  users: [demoUser, deliveryLead, productEngineer, designLead],
  memberships: [
    demoMembership,
    {
      workspaceId: demoWorkspace.id,
      userId: deliveryLead.id,
      role: roles.projectManager,
      email: deliveryLead.email,
      name: deliveryLead.name
    },
    {
      workspaceId: demoWorkspace.id,
      userId: productEngineer.id,
      role: roles.member,
      email: productEngineer.email,
      name: productEngineer.name
    },
    {
      workspaceId: demoWorkspace.id,
      userId: designLead.id,
      role: roles.member,
      email: designLead.email,
      name: designLead.name
    }
  ],
  portfolios: [
    {
      id: "portfolio-growth",
      workspaceId: demoWorkspace.id,
      name: "Growth Portfolio",
      description: "Market-facing workstreams",
      archived: false,
      version: 1,
      createdAt: fixedNow,
      updatedAt: fixedNow
    }
  ],
  projects: [
    {
      id: "project-pilot",
      workspaceId: demoWorkspace.id,
      portfolioId: "portfolio-growth",
      name: "Pilot Readiness",
      description: "Prepare the Team Spaces pilot environment.",
      ownerId: demoUser.id,
      status: "active",
      health: "watch",
      priority: "high",
      phase: "Execution",
      startDate: "2026-07-01",
      targetDate: "2026-08-15",
      percentComplete: 42,
      archived: false,
      favorite: true,
      tags: ["pilot", "aws"],
      version: 1,
      createdAt: fixedNow,
      updatedAt: fixedNow
    },
    {
      id: "project-workspace-ux",
      workspaceId: demoWorkspace.id,
      portfolioId: "portfolio-growth",
      name: "Workspace UX",
      description: "Simplify the core workspace experience for project teams.",
      ownerId: deliveryLead.id,
      status: "active",
      health: "on-track",
      priority: "high",
      phase: "Execution",
      startDate: "2026-07-08",
      targetDate: "2026-08-05",
      percentComplete: 28,
      archived: false,
      favorite: true,
      tags: ["ux", "workflow"],
      version: 1,
      createdAt: fixedNow,
      updatedAt: fixedNow
    }
  ],
  workConfigurations: [],
  workItems: [
    {
      id: "work-cognito",
      projectId: "project-pilot",
      workspaceId: demoWorkspace.id,
      type: "feature",
      title: "Connect Cognito hosted UI",
      description: "Wire the hosted Cognito flow through the production runtime config and keep local demo mode available for development.",
      status: "in-progress",
      priority: "high",
      assigneeId: demoUser.id,
      reporterId: demoUser.id,
      dueDate: "2026-07-17",
      estimateMinutes: 240,
      recordedMinutes: 45,
      effortPoints: 5,
      periodId: "period-pilot-1",
      periodName: "Pilot Period 1",
      periodGoal: "Authenticate pilot users and stabilize the workspace shell.",
      intakeGroup: "ready",
      milestoneName: "Pilot beta",
      parentId: "work-dns",
      blockedBy: ["work-dns"],
      relatedIds: ["work-cost-meter"],
      watcherIds: [deliveryLead.id, productEngineer.id],
      acceptanceCriteria: "Production runtime config points to the configured Cognito domain; unauthenticated users are redirected to sign in; local demo mode still starts without AWS credentials.",
      customFields: {
        component: "Authentication",
        risk: "Pilot users cannot enter the workspace"
      },
      rank: 10,
      tags: ["auth"],
      version: 1,
      createdAt: fixedNow,
      updatedAt: fixedNow
    },
    {
      id: "work-dns",
      projectId: "project-pilot",
      workspaceId: demoWorkspace.id,
      type: "milestone",
      title: "Application DNS cutover",
      description: "Validate the Team Spaces certificate and switch the application hostname to its CloudFront distribution.",
      status: "ready",
      priority: "medium",
      assigneeId: deliveryLead.id,
      reporterId: demoUser.id,
      dueDate: "2026-07-24",
      estimateMinutes: 60,
      recordedMinutes: 0,
      effortPoints: 2,
      periodId: "period-pilot-1",
      periodName: "Pilot Period 1",
      periodGoal: "Authenticate pilot users and stabilize the workspace shell.",
      intakeGroup: "ready",
      milestoneName: "Pilot beta",
      watcherIds: [demoUser.id, deliveryLead.id],
      acceptanceCriteria: "The certificate is issued, the example hostname points at the Team Spaces distribution, and the authentication smoke check passes.",
      customFields: {
        gate: "Pilot launch"
      },
      rank: 20,
      tags: ["dns"],
      version: 1,
      createdAt: fixedNow,
      updatedAt: fixedNow
    },
    {
      id: "work-planning-board",
      projectId: "project-workspace-ux",
      workspaceId: demoWorkspace.id,
      type: "feature",
      title: "Create planning board with flow signal",
      description: "Make planned work visible without configuration so the pilot team can run daily review from one board.",
      status: "ready",
      priority: "high",
      assigneeId: productEngineer.id,
      reporterId: deliveryLead.id,
      dueDate: "2026-07-18",
      estimateMinutes: 360,
      recordedMinutes: 0,
      effortPoints: 8,
      periodId: "period-pilot-1",
      periodName: "Pilot Period 1",
      periodGoal: "Authenticate pilot users and stabilize the workspace shell.",
      intakeGroup: "ready",
      milestoneName: "Pilot beta",
      parentId: "work-dns",
      watcherIds: [demoUser.id, designLead.id],
      acceptanceCriteria: "Cards are grouped by status, WIP limit is visible, and moving a card updates the underlying task status.",
      customFields: {
        component: "Planning board"
      },
      rank: 30,
      tags: ["planning", "board"],
      version: 1,
      createdAt: fixedNow,
      updatedAt: fixedNow
    },
    {
      id: "work-cost-meter",
      projectId: "project-pilot",
      workspaceId: demoWorkspace.id,
      type: "bug",
      title: "Fix dashboard cost meter permissions",
      description: "Keep financial and time signals scoped to users who can see project reporting.",
      status: "blocked",
      priority: "critical",
      assigneeId: productEngineer.id,
      reporterId: demoUser.id,
      dueDate: "2026-07-16",
      estimateMinutes: 180,
      recordedMinutes: 30,
      effortPoints: 3,
      periodId: "period-pilot-1",
      periodName: "Pilot Period 1",
      periodGoal: "Authenticate pilot users and stabilize the workspace shell.",
      intakeGroup: "bugs",
      milestoneName: "Pilot beta",
      blockedBy: ["work-permission-model"],
      watcherIds: [demoUser.id],
      acceptanceCriteria: "Members can see their own time, managers can see project totals, and unauthorized requests return a problem response.",
      customFields: {
        severity: "S1",
        area: "Reporting"
      },
      rank: 40,
      tags: ["permissions", "dashboard"],
      version: 1,
      createdAt: fixedNow,
      updatedAt: fixedNow
    },
    {
      id: "work-permission-model",
      projectId: "project-pilot",
      workspaceId: demoWorkspace.id,
      type: "task",
      title: "Finish workspace permission matrix",
      description: "Define workspace, portfolio, project, task, time, report, attachment, and saved view permissions.",
      status: "done",
      priority: "high",
      assigneeId: deliveryLead.id,
      reporterId: demoUser.id,
      dueDate: "2026-07-11",
      estimateMinutes: 240,
      recordedMinutes: 210,
      effortPoints: 5,
      periodId: "period-pilot-1",
      periodName: "Pilot Period 1",
      periodGoal: "Authenticate pilot users and stabilize the workspace shell.",
      intakeGroup: "maintenance",
      milestoneName: "Pilot beta",
      watcherIds: [deliveryLead.id],
      acceptanceCriteria: "Role permission mapping is documented and enforced by the API before repository mutations.",
      customFields: {
        control: "RBAC"
      },
      rank: 50,
      tags: ["rbac"],
      version: 1,
      createdAt: fixedNow,
      updatedAt: fixedNow
    },
    {
      id: "work-onboarding-flow",
      projectId: "project-workspace-ux",
      workspaceId: demoWorkspace.id,
      type: "feature",
      title: "Design first-run project setup flow",
      description: "Reduce setup friction for the first pilot cohort while preserving a clear portfolio and project structure.",
      status: "intake",
      priority: "medium",
      assigneeId: designLead.id,
      reporterId: deliveryLead.id,
      dueDate: "2026-07-29",
      estimateMinutes: 300,
      recordedMinutes: 0,
      effortPoints: 5,
      periodId: "period-pilot-2",
      periodName: "Pilot Period 2",
      periodGoal: "Make workspace setup obvious for the first pilot cohort.",
      intakeGroup: "ideas",
      milestoneName: "Pilot beta",
      relatedIds: ["work-planning-board"],
      watcherIds: [deliveryLead.id],
      acceptanceCriteria: "A new workspace owner can create a portfolio, project, and first task without reading help text.",
      customFields: {
        userJourney: "First run"
      },
      rank: 60,
      tags: ["onboarding"],
      version: 1,
      createdAt: fixedNow,
      updatedAt: fixedNow
    },
    {
      id: "work-s3-attachments",
      projectId: "project-pilot",
      workspaceId: demoWorkspace.id,
      type: "task",
      title: "Harden S3 attachment metadata",
      description: "Preserve document provenance while keeping bytes private in S3.",
      status: "in-progress",
      priority: "medium",
      assigneeId: demoUser.id,
      reporterId: deliveryLead.id,
      dueDate: "2026-07-22",
      estimateMinutes: 220,
      recordedMinutes: 60,
      effortPoints: 3,
      periodId: "period-pilot-2",
      periodName: "Pilot Period 2",
      periodGoal: "Make workspace setup obvious for the first pilot cohort.",
      intakeGroup: "maintenance",
      milestoneName: "Launch readiness",
      relatedIds: ["work-cognito"],
      watcherIds: [demoUser.id, deliveryLead.id],
      acceptanceCriteria: "Document metadata contains project, uploader, status, category, tags, and object key; downloads are short-lived signed links.",
      customFields: {
        storage: "S3"
      },
      rank: 70,
      tags: ["attachments", "s3"],
      version: 1,
      createdAt: fixedNow,
      updatedAt: fixedNow
    },
    {
      id: "work-milestone-export",
      projectId: "project-workspace-ux",
      workspaceId: demoWorkspace.id,
      type: "feature",
      title: "Export milestone plan to CSV",
      description: "Give delivery leads a portable milestone snapshot for stakeholder updates.",
      status: "intake",
      priority: "low",
      assigneeId: deliveryLead.id,
      reporterId: demoUser.id,
      dueDate: "2026-08-02",
      estimateMinutes: 160,
      recordedMinutes: 0,
      effortPoints: 2,
      periodId: "period-pilot-2",
      periodName: "Pilot Period 2",
      periodGoal: "Make workspace setup obvious for the first pilot cohort.",
      intakeGroup: "ideas",
      milestoneName: "Launch readiness",
      parentId: "work-onboarding-flow",
      watcherIds: [deliveryLead.id],
      acceptanceCriteria: "Milestone plan export includes project, title, status, assignee, effort, and target milestone.",
      customFields: {
        audience: "Delivery leads"
      },
      rank: 80,
      tags: ["milestone", "reporting"],
      version: 1,
      createdAt: fixedNow,
      updatedAt: fixedNow
    }
  ],
  documents: [
    {
      id: "doc-pilot-brief",
      workspaceId: demoWorkspace.id,
      projectId: "project-pilot",
      workItemId: "work-s3-attachments",
      name: "Pilot readiness brief",
      filename: "pilot-readiness-brief.md",
      contentType: "text/markdown",
      sizeBytes: 4096,
      category: "brief",
      description: "Workspace pilot context, risks, and launch assumptions.",
      tags: ["pilot", "readiness"],
      objectKey: "documents/workspace-default/project-pilot/doc-pilot-brief/pilot-readiness-brief.md",
      status: "ready",
      uploadedBy: demoUser.id,
      version: 1,
      createdAt: fixedNow,
      updatedAt: fixedNow
    }
  ],
  timeEntries: [
    {
      id: "time-1",
      workspaceId: demoWorkspace.id,
      userId: demoUser.id,
      projectId: "project-pilot",
      entryDate: "2026-07-10",
      durationMinutes: 45,
      description: "Reviewed deployment checklist",
      billable: false,
      version: 1,
      createdAt: fixedNow,
      updatedAt: fixedNow
    }
  ]
});

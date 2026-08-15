// @ts-nocheck

import {
  parseAccountInput,
  parseActivityInput,
  parseDocumentFinalizeInput,
  parseDocumentPatchInput,
  parseDocumentUploadIntentInput,
  parseMembershipInput,
  parseMeetingIdentifier,
  parseMeetingInput,
  parseMeetingPatchInput,
  parseMeetingQuery,
  parsePortfolioInput,
  parsePortfolioPatchInput,
  parseProfileInput,
  parseProjectInput,
  parseProjectPatchInput,
  parseSavedViewInput,
  parseTimeEntryInput,
  parseWorkConfigurationInput,
  parseWorkQuery,
  parseWorkItemInput,
  parseWorkItemPatchInput,
  parseWorkspaceInput
} from "@teamspaces/contracts";
import {buildPlanningSummary} from "@teamspaces/domain";
import {permissions, requirePermission} from "../authorization/rbac.js";
import {NotFoundError, ValidationError} from "../errors.js";
import {parseListOptions} from "../validation/http.js";

/**
 * @param {string} path
 * @param {string} prefix
 */
function stripPrefix(path, prefix) {
  return path.startsWith(prefix) ? path.slice(prefix.length) || "/" : path;
}

function accountFilters(context) {
  return {
    workspaceId: context.workspaceId,
    allowedProjectIds: context.membership?.projectIds
  };
}

function publicListLimit(context) {
  const limit = Number(context.publicDemo?.pageLimit);
  return Number.isInteger(limit) && limit > 0 ? limit : undefined;
}

function publicListReadLimit(context) {
  const limit = publicListLimit(context);
  return limit ? limit + 1 : undefined;
}

function listEnvelope(items, context) {
  const limit = publicListLimit(context);
  const visible = limit ? items.slice(0, limit) : items;
  return {
    items: visible,
    pageInfo: {
      hasNextPage: false,
      ...(limit && items.length > visible.length ? {truncated: true} : {})
    }
  };
}

function meetingPathIdentifier(value) {
  try {
    return parseMeetingIdentifier(decodeURIComponent(value), "meetingId");
  } catch (error) {
    if (error instanceof URIError) throw new ValidationError("meetingId is invalid");
    throw error;
  }
}

/**
 * @param {{method: string, path: string, searchParams: URLSearchParams, body: unknown, context: any, repository: any}} request
 */
export async function route(request) {
  const path = stripPrefix(stripPrefix(request.path, "/api/v1/demo"), "/api/v1");
  const {method, body, context, repository, searchParams} = request;

  if (method === "GET" && path === "/health") {
    return {
      ok: true,
      service: "teamspaces-api",
      tableConfigured: Boolean(process.env.TABLE_NAME || repository),
      attachmentBucketConfigured: Boolean(process.env.ATTACHMENT_BUCKET_NAME || repository)
    };
  }

  if (method === "GET" && path === "/bootstrap") {
    requirePermission(context, permissions.workspaceRead);
    const [portfolios, projects, summary, workConfiguration] = await Promise.all([
      repository.listPortfolios(context),
      repository.listProjects({limit: 25, ...accountFilters(context)}),
      repository.getPortfolioSummary(context),
      repository.getWorkConfiguration(context)
    ]);
    return {
      user: context.user,
      workspace: context.workspace,
      membership: context.membership,
      portfolios,
      projects,
      summary,
      workConfiguration,
      ...(context.publicDemo ? {publicDemo: context.publicDemo.metadata} : {})
    };
  }

  if (method === "GET" && path === "/me") {
    requirePermission(context, permissions.workspaceRead);
    return {user: context.user, workspace: context.workspace, membership: context.membership};
  }

  if (method === "GET" && path === "/accounts") {
    requirePermission(context, permissions.workspaceRead);
    return {...listEnvelope(await repository.listAccounts(context.actorId), context), currentAccountId: context.workspaceId};
  }
  if (method === "POST" && path === "/accounts") {
    requirePermission(context, permissions.workspaceRead);
    return {statusCode: 201, body: await repository.createAccount(context, parseAccountInput(body))};
  }

  if (method === "PATCH" && path === "/me/profile") {
    requirePermission(context, permissions.workspaceRead);
    return repository.updateCurrentUserProfile(context, parseProfileInput(body));
  }

  if (method === "GET" && path === "/workspace") {
    requirePermission(context, permissions.workspaceRead);
    return repository.getWorkspace(context);
  }
  if (method === "PATCH" && path === "/workspace") {
    requirePermission(context, permissions.workspaceManage);
    return repository.patchWorkspace(context, parseWorkspaceInput(body));
  }

  if (method === "GET" && path === "/work-configuration") {
    requirePermission(context, permissions.workspaceRead);
    return repository.getWorkConfiguration(context);
  }
  if (method === "PATCH" && path === "/work-configuration") {
    requirePermission(context, permissions.workspaceManage);
    return repository.patchWorkConfiguration(context, parseWorkConfigurationInput(body));
  }

  if (method === "GET" && path === "/memberships") {
    requirePermission(context, permissions.workspaceRead);
    return listEnvelope(await repository.listMemberships(context), context);
  }
  if (method === "POST" && path === "/memberships") {
    requirePermission(context, permissions.workspaceManage);
    return {statusCode: 201, body: await repository.upsertMembership(context, parseMembershipInput(body))};
  }

  const membershipMatch = path.match(/^\/memberships\/([^/]+)$/);
  if (membershipMatch && method === "PATCH") {
    requirePermission(context, permissions.workspaceManage);
    return repository.patchMembership(context, membershipMatch[1], parseMembershipInput(body));
  }

  if (method === "GET" && path === "/portfolios") {
    requirePermission(context, permissions.workspaceRead);
    return listEnvelope(await repository.listPortfolios(context), context);
  }

  if (method === "POST" && path === "/portfolios") {
    requirePermission(context, permissions.portfolioManage);
    return {statusCode: 201, body: await repository.createPortfolio(context, parsePortfolioInput(body))};
  }

  const portfolioMatch = path.match(/^\/portfolios\/([^/]+)$/);
  if (portfolioMatch && method === "GET") {
    requirePermission(context, permissions.workspaceRead);
    const item = (await repository.listPortfolios(context)).find((portfolio) => portfolio.id === portfolioMatch[1]);
    if (!item) throw new NotFoundError("Portfolio not found");
    return item;
  }
  if (portfolioMatch && method === "PATCH") {
    requirePermission(context, permissions.portfolioManage);
    return repository.patchPortfolio(context, portfolioMatch[1], parsePortfolioPatchInput(body));
  }

  if (method === "GET" && path === "/projects") {
    requirePermission(context, permissions.workspaceRead);
    return listEnvelope(await repository.listProjects({...parseListOptions(searchParams), ...accountFilters(context)}), context);
  }
  if (method === "POST" && path === "/projects") {
    requirePermission(context, permissions.projectCreate);
    return {statusCode: 201, body: await repository.createProject(context, parseProjectInput(body))};
  }

  const projectMatch = path.match(/^\/projects\/([^/]+)$/);
  if (projectMatch && method === "GET") {
    requirePermission(context, permissions.workspaceRead);
    return repository.getProject(projectMatch[1], context.workspaceId, context.membership?.projectIds);
  }
  if (projectMatch && method === "PATCH") {
    requirePermission(context, permissions.projectManage);
    return repository.patchProject(context, projectMatch[1], parseProjectPatchInput(body));
  }

  const projectWorkMatch = path.match(/^\/projects\/([^/]+)\/work-items$/);
  if (projectWorkMatch && method === "GET") {
    requirePermission(context, permissions.workspaceRead);
    return repository.listWorkItemsPage({
      ...parseWorkQuery(searchParams, {projectId: projectWorkMatch[1], defaultSort: "id-asc"}),
      ...accountFilters(context)
    });
  }
  if (projectWorkMatch && method === "POST") {
    requirePermission(context, permissions.workManage);
    return {statusCode: 201, body: await repository.createWorkItem(context, projectWorkMatch[1], parseWorkItemInput(body))};
  }

  const projectWorkItemMatch = path.match(/^\/projects\/([^/]+)\/work-items\/([^/]+)$/);
  if (projectWorkItemMatch && method === "PATCH") {
    requirePermission(context, permissions.workManage);
    return repository.patchWorkItem(context, projectWorkItemMatch[1], projectWorkItemMatch[2], parseWorkItemPatchInput(body));
  }

  if (method === "GET" && path === "/work-items/assigned") {
    requirePermission(context, permissions.workspaceRead);
    return listEnvelope(await repository.listAssignedWork(context.actorId, {
      ...accountFilters(context),
      limit: publicListReadLimit(context)
    }), context);
  }

  if (method === "GET" && path === "/planning") {
    requirePermission(context, permissions.workspaceRead);
    const workConfiguration = await repository.getWorkConfiguration(context);
    const query = {...parseWorkQuery(searchParams), ...accountFilters(context), workConfiguration};
    const page = await repository.listPlanningWorkItemsPage(query);
    return {
      ...page,
      summary: buildPlanningSummary(page.items, workConfiguration),
      summaryScope: page.queryMode === "legacy-transition"
        ? "legacy-transition"
        : query.cursor || page.pageInfo.hasNextPage
          ? "page"
          : "result"
    };
  }

  if (method === "GET" && path === "/meetings") {
    requirePermission(context, permissions.workspaceRead);
    return repository.listMeetingsPage(context, parseMeetingQuery(searchParams));
  }
  if (method === "POST" && path === "/meetings") {
    requirePermission(context, permissions.meetingManage);
    return {statusCode: 201, body: await repository.createMeeting(context, parseMeetingInput(body))};
  }

  const meetingMatch = path.match(/^\/meetings\/([^/]+)$/);
  if (meetingMatch && method === "GET") {
    requirePermission(context, permissions.workspaceRead);
    const projectId = parseMeetingIdentifier(searchParams.get("projectId"), "projectId");
    return repository.getMeeting(context, projectId, meetingPathIdentifier(meetingMatch[1]));
  }
  if (meetingMatch && method === "PATCH") {
    requirePermission(context, permissions.meetingManage);
    const input = parseMeetingPatchInput(body);
    return repository.patchMeeting(context, input.projectId, meetingPathIdentifier(meetingMatch[1]), input);
  }

  if (method === "GET" && path === "/time-entries") {
    requirePermission(context, permissions.workspaceRead);
    return listEnvelope(await repository.listTimeEntries({
      ...accountFilters(context),
      userId: context.actorId,
      projectId: searchParams.get("projectId") ?? undefined,
      limit: publicListReadLimit(context)
    }), context);
  }
  if (method === "POST" && path === "/time-entries") {
    requirePermission(context, permissions.timeManageOwn);
    return {statusCode: 201, body: await repository.createTimeEntry(context, parseTimeEntryInput(body))};
  }

  if (method === "GET" && path === "/activity") {
    requirePermission(context, permissions.workspaceRead);
    const projectId = searchParams.get("projectId") ?? undefined;
    if (projectId) await repository.getProject(projectId, context.workspaceId, context.membership?.projectIds);
    return listEnvelope(await repository.listActivity(projectId, context.workspaceId, publicListReadLimit(context)), context);
  }
  if (method === "POST" && path === "/activity") {
    requirePermission(context, permissions.workManage);
    const input = parseActivityInput(body);
    await repository.getProject(input.projectId, context.workspaceId, context.membership?.projectIds);
    await repository.recordActivity(context, input.projectId, input.entityType, input.entityId, "comment.created", ["summary"], input.summary);
    return {statusCode: 201, body: {ok: true}};
  }

  if (method === "GET" && path === "/documents") {
    requirePermission(context, permissions.workspaceRead);
    return {items: await repository.listDocuments({...parseListOptions(searchParams), ...accountFilters(context)}), pageInfo: {hasNextPage: false}};
  }
  if (method === "POST" && path === "/documents/upload-intent") {
    requirePermission(context, permissions.attachmentManage);
    return {statusCode: 201, body: await repository.createDocumentUploadIntent(context, parseDocumentUploadIntentInput(body))};
  }
  if (method === "POST" && path === "/documents/finalize") {
    requirePermission(context, permissions.attachmentManage);
    return {statusCode: 201, body: await repository.finalizeDocument(context, parseDocumentFinalizeInput(body))};
  }

  const documentDownloadMatch = path.match(/^\/documents\/([^/]+)\/download$/);
  if (documentDownloadMatch && method === "GET") {
    requirePermission(context, permissions.workspaceRead);
    const projectId = searchParams.get("projectId");
    if (!projectId) throw new ValidationError("projectId is required");
    return repository.createDocumentDownloadIntent(context, projectId, documentDownloadMatch[1]);
  }

  const documentMatch = path.match(/^\/documents\/([^/]+)$/);
  if (documentMatch && method === "PATCH") {
    requirePermission(context, permissions.attachmentManage);
    const projectId = searchParams.get("projectId");
    if (!projectId) throw new ValidationError("projectId is required");
    return repository.patchDocument(context, projectId, documentMatch[1], parseDocumentPatchInput(body));
  }

  if (method === "GET" && path === "/saved-views") {
    requirePermission(context, permissions.workspaceRead);
    return listEnvelope(await repository.listSavedViews(context.actorId, context.workspaceId, publicListReadLimit(context)), context);
  }
  if (method === "POST" && path === "/saved-views") {
    requirePermission(context, permissions.savedViewManage);
    return {statusCode: 201, body: await repository.createSavedView(context, parseSavedViewInput(body))};
  }

  if (method === "GET" && path === "/reports/portfolio-summary") {
    requirePermission(context, permissions.reportRead);
    return repository.getPortfolioSummary(context);
  }
  if (method === "GET" && path === "/reports/planning-summary") {
    requirePermission(context, permissions.reportRead);
    return repository.getPlanningSummary(context);
  }
  if (method === "GET" && path === "/reports/project-timeline") {
    requirePermission(context, permissions.reportRead);
    return {items: await repository.getProjectTimeline(context)};
  }

  if (method === "GET" && path === "/application-data/summary") {
    requirePermission(context, permissions.workspaceRead);
    return repository.getApplicationDataSummary(context);
  }

  if (method === "POST" && path === "/attachments/upload-intent") {
    requirePermission(context, permissions.attachmentManage);
    return {statusCode: 201, body: await repository.createUploadIntent(context, parseDocumentUploadIntentInput(body))};
  }
  if (method === "POST" && path === "/attachments/finalize") {
    requirePermission(context, permissions.attachmentManage);
    return {statusCode: 201, body: await repository.finalizeDocument(context, parseDocumentFinalizeInput(body))};
  }

  const attachmentDownloadMatch = path.match(/^\/attachments\/([^/]+)\/download$/);
  if (attachmentDownloadMatch && method === "GET") {
    requirePermission(context, permissions.workspaceRead);
    const projectId = searchParams.get("projectId");
    if (!projectId) throw new ValidationError("projectId is required");
    return repository.createDocumentDownloadIntent(context, projectId, attachmentDownloadMatch[1]);
  }

  throw new NotFoundError("Route not found");
}

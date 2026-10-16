// @ts-nocheck

import {ServiceUnavailableError, ValidationError} from "../errors.js";

export const githubProjectsQuery = `query TeamSpacesProjectSnapshot($projectId: ID!, $after: String) {
  node(id: $projectId) {
    __typename
    ... on ProjectV2 {
      id title url public
      repositories(first: 100) {
        nodes { id nameWithOwner isPrivate }
        pageInfo { hasNextPage endCursor }
      }
      fields(first: 50) {
        nodes {
          ... on ProjectV2Field { id name dataType }
          ... on ProjectV2SingleSelectField { id name dataType options { id name } }
          ... on ProjectV2IterationField { id name dataType }
        }
        pageInfo { hasNextPage endCursor }
      }
      items(first: 25, after: $after) {
        nodes {
          id type isArchived updatedAt
          content {
            __typename
            ... on Issue { id number title url state updatedAt repository { id nameWithOwner isPrivate } }
            ... on PullRequest { id number title url state updatedAt repository { id nameWithOwner isPrivate } }
            ... on DraftIssue { id title updatedAt }
          }
          fieldValues(first: 50) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue { name optionId field { ... on ProjectV2SingleSelectField { id name } } }
              ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2Field { id name } } }
              ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2Field { id name } } }
              ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2Field { id name } } }
              ... on ProjectV2ItemFieldIterationValue { iterationId title startDate duration field { ... on ProjectV2IterationField { id name } } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

function pageInfo(value) {
  if (typeof value?.hasNextPage !== "boolean" || value.hasNextPage && typeof value.endCursor !== "string") throw new ServiceUnavailableError("GitHub Projects returned incomplete pagination metadata");
  return {hasNextPage: value?.hasNextPage === true, ...(typeof value?.endCursor === "string" ? {endCursor: value.endCursor} : {})};
}

function boundedText(value, length = 2000) {
  return typeof value === "string" ? value.slice(0, length) : "";
}

function fieldValue(value) {
  const base = {type: value.__typename, fieldId: value.field?.id, fieldName: boundedText(value.field?.name, 160)};
  switch (value.__typename) {
    case "ProjectV2ItemFieldSingleSelectValue": return {...base, name: boundedText(value.name, 160), optionId: value.optionId};
    case "ProjectV2ItemFieldTextValue": return {...base, text: boundedText(value.text)};
    case "ProjectV2ItemFieldNumberValue": return {...base, number: value.number};
    case "ProjectV2ItemFieldDateValue": return {...base, date: value.date};
    case "ProjectV2ItemFieldIterationValue": return {...base, iterationId: value.iterationId, title: boundedText(value.title, 160), startDate: value.startDate, duration: value.duration};
    default: return {...base, supported: false};
  }
}

/** One bounded authenticated snapshot; no mutation or public-tracker ingestion. */
export async function readGitHubProject({projectId, repository, visibility, includeDrafts = false, sharedRepositories = [], statusField = "Status", cursor = "", query = "", request}) {
  if (typeof projectId !== "string" || !/^[A-Za-z0-9_=-]{1,256}$/.test(projectId)) throw new ValidationError("githubProjectId must be an opaque GitHub project node identifier");
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split("/").some((part) => [".", ".."].includes(part))) throw new ValidationError("GitHub Projects requires an exact owner/repository scope");
  if (!["public", "private"].includes(visibility) || typeof includeDrafts !== "boolean") throw new ValidationError("GitHub Projects requires an expected board visibility and explicit draft policy");
  if (!Array.isArray(sharedRepositories) || sharedRepositories.length > 10 || sharedRepositories.length && visibility !== "private" || sharedRepositories.some((value) => typeof value !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) || value.split("/").some((part) => [".", ".."].includes(part)))) throw new ValidationError("Shared repositories require an explicit bounded allowlist on a private board");
  const shared = new Set(sharedRepositories.map((value) => value.toLowerCase()));
  if (typeof cursor !== "string" || cursor.length > 500 || cursor && !/^[A-Za-z0-9+/=_-]+$/.test(cursor)) throw new ValidationError("GitHub Projects cursor is invalid");
  if (typeof query !== "string" || query.length > 240) throw new ValidationError("GitHub Projects query is too long");
  if (typeof statusField !== "string" || !statusField.trim() || statusField.length > 160) throw new ValidationError("GitHub Projects status field is invalid");
  const payload = await request({query: githubProjectsQuery, variables: {projectId, after: cursor || null}});
  if (!payload || payload.errors?.length || payload.data?.node?.__typename !== "ProjectV2" || payload.data.node.id !== projectId) throw new ServiceUnavailableError("GitHub Projects could not be read; verify the selected board and Projects read permission");
  const project = payload.data.node;
  const repositoriesPageInfo = pageInfo(project.repositories?.pageInfo);
  if (!Array.isArray(project.repositories?.nodes) || project.repositories.nodes.length > 100 || repositoriesPageInfo.hasNextPage) throw new ServiceUnavailableError("GitHub Projects repository association could not be verified completely");
  const scopeRepository = project.repositories.nodes.find((entry) => entry?.nameWithOwner?.toLowerCase() === repository.toLowerCase());
  if (!scopeRepository || typeof project.public !== "boolean" || project.public !== (visibility === "public")) throw new ServiceUnavailableError("GitHub Projects board does not match its configured repository and visibility");
  if (!Array.isArray(project.items?.nodes) || project.items.nodes.length > 25 || !Array.isArray(project.fields?.nodes) || project.fields.nodes.length > 50) throw new ServiceUnavailableError("GitHub Projects returned an invalid bounded snapshot");
  const itemsPageInfo = pageInfo(project.items.pageInfo);
  const fieldsPageInfo = pageInfo(project.fields.pageInfo);
  let redactedCount = 0;
  let filteredCount = 0;
  let valuesTruncated = false;
  const items = [];
  for (const item of project.items.nodes) {
    const content = item?.content;
    if (!content || item.type === "REDACTED") { redactedCount += 1; continue; }
    const draft = content.__typename === "DraftIssue";
    const primary = content.repository?.nameWithOwner?.toLowerCase() === repository.toLowerCase();
    const sharedPublic = shared.has(content.repository?.nameWithOwner?.toLowerCase()) && content.repository?.isPrivate === false;
    if (draft ? !includeDrafts : !["Issue", "PullRequest"].includes(content.__typename) || !primary && !sharedPublic) { filteredCount += 1; continue; }
    if (!Array.isArray(item.fieldValues?.nodes) || item.fieldValues.nodes.length > 50) throw new ServiceUnavailableError("GitHub Projects returned invalid field values");
    const fieldValuesPageInfo = pageInfo(item.fieldValues.pageInfo);
    valuesTruncated ||= fieldValuesPageInfo.hasNextPage;
    if (query && !`${content.title} ${content.number}`.toLowerCase().includes(query.toLowerCase())) continue;
    items.push({
      id: item.id, title: boundedText(content.title, 240), kind: "project-item",
      linkType: draft ? "collaboration" : content.__typename === "Issue" ? "issue" : "development", externalUrl: draft ? project.url : content.url,
      metadata: {
        projectNodeId: project.id, contentNodeId: content.id, contentType: content.__typename,
        repository: draft ? scopeRepository.nameWithOwner : content.repository.nameWithOwner,
        repositoryVisibility: (draft ? scopeRepository.isPrivate : content.repository.isPrivate) === true ? "private" : "public",
        repositoryMapping: draft ? "configured-board" : primary ? "content-repository" : "shared-public-repository",
        state: content.state, number: content.number, archived: item.isArchived === true, updatedAt: item.updatedAt,
        status: item.fieldValues.nodes.find((value) => value?.__typename === "ProjectV2ItemFieldSingleSelectValue" && value.field?.name === statusField)?.name,
        fieldValues: item.fieldValues.nodes.filter(Boolean).map(fieldValue), fieldValuesPageInfo
      }
    });
  }
  return {
    project: {
      id: project.id, title: boundedText(project.title, 240), url: project.url, public: project.public === true,
      fields: project.fields.nodes.filter(Boolean).map((field) => ({id: field.id, name: boundedText(field.name, 160), dataType: field.dataType, ...(Array.isArray(field.options) ? {options: field.options.slice(0, 100).map((option) => ({id: option.id, name: boundedText(option.name, 160)})), optionsTruncated: field.options.length > 100} : {})}))
    },
    items, itemsPageInfo, fieldsPageInfo, repositoriesPageInfo,
    ...(itemsPageInfo.hasNextPage && itemsPageInfo.endCursor ? {nextCursor: itemsPageInfo.endCursor} : {}),
    redacted: redactedCount > 0, filtered: filteredCount > 0, redactedCount, filteredCount,
    truncated: itemsPageInfo.hasNextPage || fieldsPageInfo.hasNextPage || valuesTruncated || project.fields.nodes.some((field) => field?.options?.length > 100),
    queryScope: "current-page"
  };
}

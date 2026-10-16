---
title: Meetings
---

<span id="public-demo-entry" hidden></span>

```js
import {apiClient} from "../lib/api.js";
import {meetingTourMeetingId, meetingTourProjectId} from "../lib/public-demo-tour.js";
import {actionPanel, buttonLink, cursorPager, emptyActionView, errorView, globalMeetingsTable, meetingDeferredNotice, meetingDetailView, meetingForm, meetingProjectSelector, meetingTaskSearchForm, meetingsWorkspace, pageHeader, toolbar, workspaceTopNav} from "../components/ui.js";
```

```js
display(workspaceTopNav());
const client = await apiClient();
const refreshPage = () => location.reload();
const params = new URLSearchParams(location.search);
const requestedProjectId = params.get("projectId") ?? "";
const requestedMeetingId = params.get("meetingId") ?? "";
const cursor = params.get("cursor") ?? "";
const taskSearch = params.get("taskSearch") ?? "";
const shellResult = await Promise.all([
  client.projects.list({limit: 100, signal: invalidation}),
  client.me({signal: invalidation}),
  client.meetings.all({limit: 50, signal: invalidation})
]).catch((error) => error);
```

```js
if (shellResult instanceof Error) {
  display(errorView(shellResult, refreshPage));
} else {
  const [projectsResult, me, globalMeetings] = shellResult;
  const projectId = meetingTourProjectId(projectsResult.items, {
    requestedProjectId,
    isPublicDemo: client.isPublicDemo
  });
  const listedProject = projectsResult.items.find((project) => project.id === projectId);
  const directProjectResult = projectId && !listedProject
    ? await client.projects.get(projectId, {signal: invalidation}).catch((error) => error)
    : undefined;
  const selectedProject = listedProject ?? (directProjectResult instanceof Error ? undefined : directProjectResult);
  const projects = selectedProject && !listedProject ? [...projectsResult.items, selectedProject] : projectsResult.items;
  const canManage = ["workspace-admin", "portfolio-manager", "project-manager", "member"].includes(me.membership?.role);
  display(pageHeader({
    eyebrow: "Workspace",
    title: selectedProject ? `${selectedProject.name} meetings` : "Meetings",
    description: selectedProject
      ? "Plan the agenda, coordinate participants, and capture decisions."
      : "Choose a project to plan and document its meetings.",
    actions: selectedProject
      ? [canManage ? buttonLink("Create meeting", "#new-meeting", {primary: true}) : undefined, buttonLink("Open project", `/app/project?id=${encodeURIComponent(selectedProject.id)}`)].filter(Boolean)
      : [buttonLink("Open projects", "/app/projects")]
  }));
  display(actionPanel("Choose project", meetingProjectSelector(projects, projectId), {id: "project-selector", open: !selectedProject, meta: selectedProject?.name ?? "Required"}));
  display(actionPanel("Workspace meetings", globalMeetingsTable(globalMeetings.items, projects), {meta: `${globalMeetings.items.length} visible meetings`}));

  if (!projectId) {
    display(emptyActionView("Select a project to open meetings", "Meeting and task requests start only after you choose a project.", {label: "Choose project", href: "#project-selector"}));
  } else if (!selectedProject) {
    display(emptyActionView("Project is unavailable", "Choose a project you can access from the selector above.", {label: "Choose another project", href: "#project-selector"}));
  } else {
    display(actionPanel("Task link search", meetingTaskSearchForm(selectedProject.id, taskSearch), {
      open: Boolean(taskSearch),
      meta: taskSearch ? `Matching “${taskSearch}”` : "Project tasks"
    }));
    const result = await Promise.all([
      client.meetings.list(selectedProject.id, {limit: 20, cursor: cursor || undefined, signal: invalidation}),
      client.workItems.list(selectedProject.id, {limit: 100, search: taskSearch || undefined, signal: invalidation}),
      client.memberships.list({signal: invalidation}),
      client.documents.list({projectId: selectedProject.id, signal: invalidation})
    ]).catch((error) => error);

    if (result instanceof Error) {
      display(errorView(result, refreshPage));
    } else {
      const [meetings, workItems, memberships, documents] = result;
      const meetingId = meetingTourMeetingId(meetings.items, {
        requestedMeetingId,
        isPublicDemo: client.isPublicDemo,
        newMeetingRequested: location.hash === "#new-meeting"
      });
      const selectedMeeting = meetingId
        ? await client.meetings.get(selectedProject.id, meetingId, {signal: invalidation}).catch((error) => error)
        : undefined;
      if (selectedMeeting instanceof Error) {
        display(errorView(selectedMeeting, refreshPage));
      } else {
        if (selectedMeeting) {
          display(meetingDetailView(selectedMeeting, client, {memberships: memberships.items, workItems: workItems.items, documents: documents.items, currentUserId: me.user?.id, canManage, onSaved: refreshPage}));
          if (canManage && !["closed", "cancelled"].includes(selectedMeeting.status)) {
            display(actionPanel("Edit meeting", meetingForm(client, selectedProject, {
              meeting: selectedMeeting,
              memberships: memberships.items,
              workItems: workItems.items,
              documents: documents.items,
              currentUserId: me.user?.id,
              onSaved: refreshPage
            }), {id: "edit-meeting", meta: "Details, agenda, participants"}));
          }
        }
        display(meetingsWorkspace(meetings.items, selectedProject, {memberships: memberships.items, cursor, canManage}));
        display(cursorPager(meetings.pageInfo, {
          path: "/app/meetings",
          params: {projectId: selectedProject.id},
          hasCursor: Boolean(cursor),
          resourceName: "meeting"
        }));
        display(toolbar([
          canManage ? actionPanel("Create meeting", meetingForm(client, selectedProject, {
            memberships: memberships.items,
            workItems: workItems.items,
            documents: documents.items,
            currentUserId: me.user?.id,
            onSaved: (meeting) => {
              if (!meeting?.id) return refreshPage();
              const detailParams = new URLSearchParams({projectId: selectedProject.id, meetingId: meeting.id});
              location.assign(`/app/meetings?${detailParams}`);
            }
          }), {id: "new-meeting", open: !meetings.items.length || location.hash === "#new-meeting", meta: "Draft agenda and participants"}) : undefined,
          actionPanel("Meeting capabilities", meetingDeferredNotice(), {meta: "Series, invitations, exports, and records"})
        ].filter(Boolean)));
      }
    }
  }
}
```

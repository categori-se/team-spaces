// @ts-nocheck

function node(tag, attributes = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null) element.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child !== undefined && child !== null) element.append(child instanceof Node ? child : String(child));
  }
  return element;
}

function label(value = "") {
  return String(value).replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function field(title, input) {
  return node("label", {class: "field"}, [node("span", {}, title), input]);
}

function select(name, options, value = "") {
  const input = node("select", {name}, options.map(([id, title]) => node("option", {value: id}, title)));
  input.value = value;
  return input;
}

function accepted(task) {
  return task.coordination?.acceptanceState === "accepted";
}

function statusOptions(configuration = {}, current = "") {
  const statuses = configuration.statuses ?? ["intake", "ready", "in-progress", "blocked", "done"].map((id) => ({id, label: label(id), active: true}));
  const options = statuses.filter((status) => status.active !== false || status.id === current).map((status) => [status.id, status.label ?? label(status.id)]);
  if (current && !options.some(([id]) => id === current)) options.push([current, label(current)]);
  return options;
}

const priorityOptions = ["critical", "high", "medium", "low"].map((id) => [id, label(id)]);

function safeUrl(value, {publicMode = false} = {}) {
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || (publicMode && loopback)) return undefined;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback && !publicMode)) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function evidenceLink(evidence, publicMode) {
  const href = safeUrl(evidence.url, {publicMode});
  return href
    ? node("a", {href, target: "_blank", rel: "noopener noreferrer"}, evidence.label || "View evidence")
    : node("span", {}, `${evidence.label || "Evidence"} (link unavailable)`);
}

function planningLink(task, title) {
  return node("a", {href: `/app/planning?projectId=${encodeURIComponent(task.projectId)}`}, title);
}

function taskIdentity(projectId, taskId) {
  return JSON.stringify([projectId, taskId]);
}

function taskDependencies(task, publicMode = false) {
  const dependencies = [
    ...(task.blockedBy ?? []).map((taskId) => ({projectId: task.projectId, taskId})),
    ...(!publicMode ? task.coordination?.dependencies ?? [] : [])
  ];
  return [...new Map(dependencies.map((dependency) => [taskIdentity(dependency.projectId, dependency.taskId), dependency])).values()];
}

function dependencyTask(dependency, tasks) {
  return tasks.get(taskIdentity(dependency.projectId, dependency.taskId)) ?? tasks.get(taskIdentity("*", dependency.taskId));
}

export function coordinationTaskForm(task, client, {roles = [], closedStatusIds = ["done"], workConfiguration = {}, onSaved} = {}) {
  const coordination = task.coordination ?? {};
  const status = node("p", {class: "form-status", role: "status", "aria-live": "polite"});
  const evidenceRows = node("div", {class: "coordination-evidence-editor"});
  const addEvidence = (evidence = {}) => {
    const row = node("div", {class: "coordination-evidence-row"});
    const remove = node("button", {class: "button button--ghost", type: "button", "aria-label": "Remove evidence link"}, "Remove");
    remove.addEventListener("click", () => row.remove());
    row.append(
      field("Evidence label", node("input", {name: "evidenceLabel", value: evidence.label ?? "", maxlength: "160"})),
      field("Evidence URL", node("input", {name: "evidenceUrl", type: "url", value: evidence.url ?? "", placeholder: "https://…"})),
      node("input", {name: "evidenceVisibility", type: "hidden", value: evidence.visibility ?? "private"}),
      node("small", {class: "coordination-hint"}, evidence.visibility === "public" ? "Public evidence" : "Private evidence"),
      remove
    );
    evidenceRows.append(row);
  };
  for (const evidence of coordination.evidence ?? []) addEvidence(evidence);
  const add = node("button", {class: "button button--ghost", type: "button"}, "Add evidence link");
  add.addEventListener("click", () => addEvidence());
  const save = node("button", {class: "button button--primary", type: "submit"}, "Save coordination");
  const form = node("form", {class: "coordination-task-form", "aria-label": `Coordination for ${task.title}`}, [
    field("Task status", select("status", statusOptions(workConfiguration, task.status), task.status)),
    field("Priority", select("priority", priorityOptions, task.priority ?? "medium")),
    field("Owner role", select("roleId", roles.map((role) => [role.id, role.name]), coordination.roleId ?? "")),
    field("Next action", node("textarea", {name: "nextAction", rows: "2", maxlength: "2000"}, coordination.nextAction ?? "")),
    field("Decision needed", node("textarea", {name: "decision", rows: "2", maxlength: "2000"}, coordination.decision ?? "")),
    field("Acceptance", select("acceptanceState", [["pending", "Pending"], ["review", "Awaiting review"], ["accepted", "Accepted"]], coordination.acceptanceState ?? "pending")),
    node("p", {class: "coordination-hint"}, "Acceptance requires a completed task status and at least one evidence link. New evidence links stay private. Update the full task and acceptance criteria in planning."),
    evidenceRows,
    add,
    save,
    status
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (save.disabled) return;
    status.textContent = "";
    try {
      const evidence = [...evidenceRows.children].flatMap((row) => {
        const evidenceLabel = row.querySelector('[name="evidenceLabel"]').value.trim();
        const url = row.querySelector('[name="evidenceUrl"]').value.trim();
        if (!evidenceLabel && !url) return [];
        if (!evidenceLabel || !safeUrl(url)) throw new Error("Each evidence link needs a label and an HTTPS URL, or an HTTP localhost URL for local review.");
        return [{label: evidenceLabel, url, visibility: row.querySelector('[name="evidenceVisibility"]').value}];
      });
      if (evidence.length > 20) throw new Error("A task can have at most 20 evidence links.");
      const acceptanceState = form.elements.acceptanceState.value;
      if (acceptanceState === "accepted" && (!closedStatusIds.includes(form.elements.status.value) || !evidence.length)) {
        throw new Error("Choose a completed task status and add at least one evidence link before accepting it.");
      }
      save.disabled = true;
      const updated = await client.workItems.patch(task.projectId, task.id, {
        version: task.version,
        status: form.elements.status.value,
        priority: form.elements.priority.value,
        coordination: {
          ...task.coordination,
          roleId: form.elements.roleId.value,
          nextAction: form.elements.nextAction.value.trim(),
          decision: form.elements.decision.value.trim(),
          acceptanceState,
          evidence
        }
      });
      if (updated?.version) Object.assign(task, updated);
      status.textContent = "Coordination saved.";
      onSaved?.();
    } catch (error) {
      status.textContent = error.status === 409 ? "This task changed. Refresh before saving again." : error.message;
    } finally {
      save.disabled = false;
    }
  });
  return form;
}

export function coordinationDelegateForm(client, {projects = [], roles = [], workConfiguration = {}, onSaved} = {}) {
  const status = node("p", {class: "form-status", role: "status", "aria-live": "polite"});
  const save = node("button", {class: "button button--primary", type: "submit"}, "Create delegated task");
  const form = node("form", {class: "coordination-delegate-form", "aria-label": "Delegate an outcome task"}, [
    field("Project", select("projectId", projects.map((project) => [project.id, project.name]), projects[0]?.id ?? "")),
    field("Task title", node("input", {name: "title", required: "true", maxlength: "240", placeholder: "What outcome should this role deliver?"})),
    field("Owner role", select("roleId", roles.map((role) => [role.id, role.name]), roles[0]?.id ?? "")),
    field("Priority", select("priority", priorityOptions, "medium")),
    field("Acceptance criteria", node("textarea", {name: "acceptanceCriteria", required: "true", rows: "3", maxlength: "10000", placeholder: "What must be true when this task is complete?"})),
    field("Next action", node("textarea", {name: "nextAction", rows: "2", maxlength: "2000", placeholder: "The first bounded action to take"})),
    node("p", {class: "coordination-hint"}, "Create work for the selected role. Agent dispatch and execution remain in private AI Studio."),
    save,
    status
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (save.disabled) return;
    status.textContent = "";
    try {
      const title = form.elements.title.value.trim();
      const acceptanceCriteria = form.elements.acceptanceCriteria.value.trim();
      const projectId = form.elements.projectId.value;
      const roleId = form.elements.roleId.value;
      if (!title || !acceptanceCriteria || !projects.some((project) => project.id === projectId) || !roles.some((role) => role.id === roleId)) {
        throw new Error("Choose a project and owner role, and describe the task outcome and acceptance criteria.");
      }
      save.disabled = true;
      await client.workItems.create(projectId, {
        title,
        type: workConfiguration.defaultTypeId ?? "task",
        status: workConfiguration.statuses?.find((item) => item.id === "ready" && item.active !== false && !item.closed)?.id ?? workConfiguration.defaultStatusId ?? "ready",
        priority: form.elements.priority.value,
        acceptanceCriteria,
        coordination: {roleId, nextAction: form.elements.nextAction.value.trim(), decision: "", acceptanceState: "pending", scopePaths: [], evidence: []}
      });
      status.textContent = "Delegated task created.";
      form.elements.title.value = "";
      form.elements.acceptanceCriteria.value = "";
      form.elements.nextAction.value = "";
      onSaved?.();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      save.disabled = false;
    }
  });
  return form;
}

function taskCard(task, context) {
  const {projects, roles, tasks, publicMode, client, canEdit, closedStatusIds, workConfiguration, onSaved} = context;
  const coordination = task.coordination ?? {};
  const project = projects.get(task.projectId);
  const dependencies = taskDependencies(task, publicMode);
  const visibleDependencies = dependencies.filter((dependency) => dependencyTask(dependency, tasks));
  const unresolved = (publicMode ? visibleDependencies : dependencies).filter((dependency) => !accepted(dependencyTask(dependency, tasks) ?? {}));
  const acceptanceLabels = {pending: "Acceptance pending", review: "Awaiting review", accepted: "Accepted"};
  const facts = node("dl", {class: "coordination-facts"});
  const fact = (title, value) => facts.append(node("dt", {}, title), node("dd", {}, value));
  fact("Project", project?.coordination?.initiativeId === "opengeo"
    ? project.coordination.facet === "community" ? "Community edition" : "Private development"
    : project?.name ?? "Project unavailable");
  fact("Owner role", roles.find((role) => role.id === coordination.roleId)?.name ?? "Unassigned");
  fact("Priority", label(task.priority ?? "medium"));
  if (coordination.parityIds?.length) fact("Parity", coordination.parityIds.join(", "));
  if (visibleDependencies.length || (!publicMode && dependencies.length)) fact("Depends on", (publicMode ? visibleDependencies : dependencies).flatMap((reference, index) => {
    const dependency = dependencyTask(reference, tasks);
    const title = dependency ? `${dependency.title} (${accepted(dependency) ? "accepted" : "pending"})` : "Restricted or unavailable task";
    const item = dependency && !publicMode
      ? node("a", {href: `/app/project?id=${encodeURIComponent(dependency.projectId)}#${encodeURIComponent(dependency.id)}`}, title)
      : node("span", {}, title);
    return index ? ["; ", item] : [item];
  }));
  const evidence = (coordination.evidence ?? []).filter((item) => !publicMode || item.visibility === "public");
  const card = node("article", {class: "coordination-task", "data-task-id": task.id}, [
    node("h4", {}, task.title),
    node("div", {class: "badge-row"}, [
      node("span", {class: "badge"}, label(task.status)),
      node("span", {class: `badge${accepted(task) ? " badge--good" : coordination.acceptanceState === "review" ? " badge--watch" : ""}`}, acceptanceLabels[coordination.acceptanceState] ?? "Acceptance pending"),
      node("span", {class: "badge"}, project?.coordination?.facet === "internal" ? "Internal" : "Community")
    ]),
    facts,
    unresolved.length ? node("p", {class: "coordination-blocker"}, `${unresolved.length} dependency outcome${unresolved.length === 1 ? " awaits" : "s await"} acceptance.`) : null,
    coordination.nextAction ? node("p", {class: "coordination-next"}, [node("strong", {}, "Next: "), coordination.nextAction]) : null,
    coordination.decision ? node("p", {class: "coordination-decision"}, [node("strong", {}, "Decision needed: "), coordination.decision]) : null,
    task.acceptanceCriteria ? node("details", {class: "coordination-detail"}, [node("summary", {}, "Acceptance criteria"), node("p", {}, task.acceptanceCriteria)]) : null,
    evidence.length ? node("section", {class: "coordination-evidence", "aria-label": "Outcome evidence"}, [
      node("strong", {}, "Evidence"),
      node("ul", {}, evidence.map((item) => node("li", {}, evidenceLink(item, publicMode))))
    ]) : null
  ]);
  if (!publicMode) {
    const run = coordination.run;
    card.append(node("details", {class: "coordination-detail coordination-run"}, [
      node("summary", {}, run ? `Latest attempt: ${label(run.state)}` : "No agent run recorded"),
      node("p", {}, "An agent run reports execution progress. Acceptance records review of the task outcome."),
      ...(run ? [
        node("p", {}, `Run ${run.id}${run.updatedAt ? ` · ${run.updatedAt}` : ""}`),
        run.sourceRevision ? node("p", {}, `Revision: ${run.sourceRevision}`) : null,
        run.url ? evidenceLink({label: "Open private run", url: run.url}, false) : null
      ] : []),
      coordination.scopePaths?.length ? node("p", {}, `Owned paths: ${coordination.scopePaths.join(", ")}`) : null,
      coordination.sourceId ? node("p", {}, `Source: ${coordination.sourceId}${coordination.taskKey ? ` / ${coordination.taskKey}` : ""}`) : null
    ]));
    card.append(node("div", {class: "mini-links"}, [
      planningLink(task, "Open planning"),
      node("a", {href: `/app/project?id=${encodeURIComponent(task.projectId)}#${encodeURIComponent(task.id)}`}, "Task details")
    ]));
    if (canEdit) card.append(node("details", {class: "coordination-detail"}, [
      node("summary", {}, "Edit coordination"),
      coordinationTaskForm(task, client, {roles, closedStatusIds, workConfiguration, onSaved})
    ]));
  }
  return card;
}

export function coordinationDashboard(data, client, {canManage = false, canEdit = false, closedStatusIds = ["done"], workConfiguration = {}, onRefresh, onSaved} = {}) {
  const publicMode = Boolean(client.isPublicCoordination || client.isPublicDemo || data.audience === "public" || data.audience === "public-demo" || data.readOnly);
  const projects = (data.projects ?? []).filter((project) => !publicMode || project.coordination?.facet === "community");
  const byProject = new Map(projects.map((project) => [project.id, project]));
  const tasks = (data.tasks ?? []).filter((task) => byProject.has(task.projectId));
  const byTask = new Map(tasks.map((task) => [taskIdentity(task.projectId, task.id), task]));
  if (publicMode) {
    for (const task of tasks) {
      if (tasks.filter((candidate) => candidate.id === task.id).length === 1) byTask.set(taskIdentity("*", task.id), task);
    }
  }
  const roles = data.roles ?? [];
  const board = node("section", {class: "coordination-dashboard", "aria-label": "Project coordination"});
  board.append(node("p", {class: "coordination-notice", role: "note"}, publicMode
    ? "Read-only community roadmap. Progress reflects recorded tasks and accepted outcomes."
    : "Private workspace · Coordinate tasks across your projects. Accepted outcomes and agent execution are tracked separately."));
  if (!publicMode && projects.length > 1) board.append(node("p", {}, "Tasks stay in their source projects. Review connected work here, with dependencies linking the outcomes each project needs."));
  if (projects.length && (!publicMode || projects.some((item) => [item.coordination?.repository, item.coordination?.githubProject].some((link) => link?.visibility === "public" && safeUrl(link.url, {publicMode}))))) {
    board.append(node("section", {class: "coordination-project-sources", "aria-label": "Project sources"}, [
      node("h2", {}, "Project sources"),
      node("table", {class: "data-table"}, [
        node("thead", {}, node("tr", {}, ["Project", "Repository", ...(!publicMode ? ["Branch", "Repository visibility"] : []), "GitHub board"].map((title) => node("th", {scope: "col"}, title)))),
        node("tbody", {}, projects.map((item) => {
          const repository = item.coordination?.repository;
          const href = !publicMode || repository?.visibility === "public" ? safeUrl(repository?.url, {publicMode}) : undefined;
          const githubProject = item.coordination?.githubProject;
          const boardHref = !publicMode || githubProject?.visibility === "public" ? safeUrl(githubProject?.url, {publicMode}) : "";
          return node("tr", {}, [
            node("td", {}, item.name),
            node("td", {}, href ? node("a", {href, target: "_blank", rel: "noopener noreferrer"}, href) : "Repository not recorded"),
            ...(!publicMode ? [node("td", {}, repository?.branch || "Not recorded"), node("td", {}, ["public", "private"].includes(repository?.visibility) ? label(repository.visibility) : "Not recorded")] : []),
            node("td", {}, boardHref ? node("a", {href: boardHref, target: "_blank", rel: "noopener noreferrer"}, "Open GitHub board") : "Not recorded")
          ]);
        }))
      ])
    ]));
  }
  const parityBaseline = data.parityBaseline;
  if (parityBaseline && ["pass", "partial", "exclusion"].every((key) => Number.isSafeInteger(parityBaseline[key]) && parityBaseline[key] >= 0)) {
    board.append(node("section", {class: "coordination-parity-baseline", "aria-label": "Recorded parity baseline"}, [
      node("h2", {}, "Recorded parity baseline"),
      parityBaseline.reference ? node("p", {}, parityBaseline.reference) : null,
      node("p", {}, "Version-pinned comparison outcomes are tracked separately from task acceptance."),
      node("div", {class: "metric-grid"}, [["Pass", parityBaseline.pass], ["Partial", parityBaseline.partial], ["Exclusion", parityBaseline.exclusion]].map(([title, value]) => node("div", {class: "metric"}, [node("strong", {}, value), node("span", {}, title)])))
    ]));
  }
  const facet = select("facet", [["", "All facets"], ["community", "Community"], ...(!publicMode ? [["internal", "Internal"]] : [])]);
  const project = select("projectId", [["", "All projects"], ...projects.map((item) => [item.id, item.name])]);
  const refresh = node("button", {class: "button", type: "button"}, "Refresh progress");
  const refreshStatus = node("p", {class: "form-status", role: "status", "aria-live": "polite"});
  refresh.addEventListener("click", async () => {
    if (refresh.disabled) return;
    refresh.disabled = true;
    try {
      await onRefresh?.();
    } catch (error) {
      refreshStatus.textContent = error.message;
    } finally {
      refresh.disabled = false;
    }
  });
  const filters = node("form", {class: "coordination-controls filter-form", "aria-label": "Filter coordination tasks"}, [field("Facet", facet), field("Project", project), refresh]);
  filters.addEventListener("submit", (event) => event.preventDefault());
  const content = node("div", {class: "coordination-content", "aria-live": "polite"});
  board.append(filters, refreshStatus, content);
  if (!publicMode && canEdit && projects.length) board.append(node("details", {class: "coordination-delegation state"}, [
    node("summary", {}, "Delegate a task"),
    coordinationDelegateForm(client, {projects, roles, workConfiguration, onSaved})
  ]));
  const render = () => {
    const filtered = tasks.filter((task) => (!project.value || task.projectId === project.value) && (!facet.value || byProject.get(task.projectId)?.coordination?.facet === facet.value));
    const blocked = (task) => !accepted(task) && (task.status === "blocked" || Boolean(String(task.coordination?.decision ?? "").trim()) || taskDependencies(task, publicMode).some((reference) => {
      const dependency = dependencyTask(reference, byTask);
      return (!publicMode || dependency) && !accepted(dependency ?? {});
    }));
    const awaitingReview = (task) => !accepted(task) && (task.coordination?.acceptanceState === "review" || closedStatusIds.includes(task.status));
    const activeAttempt = (task) => ["queued", "claimed", "preparing", "running"].includes(task.coordination?.run?.state);
    const metrics = [
      ["Tasks", filtered.length],
      ["Accepted outcomes", filtered.filter(accepted).length],
      ["Blocked", filtered.filter(blocked).length],
      ["Awaiting review", filtered.filter(awaitingReview).length],
      ["Backlog", filtered.filter((task) => !["ready", "in-progress"].includes(task.status) && !accepted(task) && !blocked(task) && !awaitingReview(task) && !activeAttempt(task)).length],
      ["Ready", filtered.filter((task) => task.status === "ready" && !accepted(task) && !blocked(task) && !awaitingReview(task) && !activeAttempt(task)).length],
      ["In progress", filtered.filter((task) => task.status === "in-progress" && !accepted(task) && !blocked(task) && !awaitingReview(task)).length]
    ];
    if (!publicMode) metrics.push(["Active attempts", filtered.filter(activeAttempt).length]);
    content.replaceChildren(node("div", {class: "metric-grid coordination-metrics"}, metrics.map(([title, value]) => node("div", {class: "metric"}, [node("strong", {}, value), node("span", {}, title)]))));
    if (!filtered.length) content.append(node("p", {class: "state state--empty"}, tasks.length ? "No tasks match these filters." : publicMode ? "No community coordination tasks are available." : "No coordination tasks are recorded for this project yet."));
    const activeRoles = roles.filter((role) => !filtered.length || filtered.some((task) => task.coordination?.roleId === role.id));
    if (filtered.some((task) => !roles.some((role) => role.id === task.coordination?.roleId))) activeRoles.push({id: "", name: "Unassigned", responsibility: "Assign an owner role before dispatching work."});
    const priorities = {critical: 0, high: 1, medium: 2, low: 3};
    if (filtered.length) content.append(node("div", {class: "coordination-lanes"}, activeRoles.map((role) => {
      const assigned = filtered.filter((task) => role.id ? task.coordination?.roleId === role.id : !roles.some((item) => item.id === task.coordination?.roleId));
      assigned.sort((left, right) => Number(accepted(left)) - Number(accepted(right)) || (priorities[left.priority] ?? 2) - (priorities[right.priority] ?? 2));
      return node("section", {class: "coordination-lane", "data-role-id": role.id}, [
        node("header", {class: "coordination-lane-heading"}, [node("h3", {}, `${role.name} · ${assigned.length}`), node("p", {}, role.responsibility)]),
        ...assigned.map((task) => taskCard(task, {projects: byProject, roles, tasks: byTask, publicMode, client, canEdit, closedStatusIds, workConfiguration, onSaved}))
      ]);
    })));
  };
  facet.addEventListener("change", () => {
    const available = projects.filter((item) => !facet.value || item.coordination?.facet === facet.value);
    const selected = available.some((item) => item.id === project.value) ? project.value : "";
    project.replaceChildren(...[["", "All projects"], ...available.map((item) => [item.id, item.name])].map(([id, title]) => node("option", {value: id}, title)));
    project.value = selected;
    render();
  });
  project.addEventListener("change", render);
  render();
  if (data.truncated) board.append(node("p", {class: "coordination-notice", role: "note"}, "This view shows a bounded selection of projects and tasks. Open project planning to review additional work."));
  return board;
}

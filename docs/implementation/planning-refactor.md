# Planning Refactor Notes

## Product Direction

Team Spaces should describe work in general, user-owned terms:

- Tasks, not tickets.
- Features and bugs for user-visible work categories.
- Time periods for bounded delivery windows.
- Intake groups for unplanned or emerging work.
- Milestones for target outcomes.
- Workflow steps and workstreams as user-named organization fields.

Stored data, UI labels, API contracts, docs, fixtures, tests, and generated examples use the neutral terms above.

## Interaction Model

The planning surface should behave like a flexible task list:

- The default page should start with a simple task creation surface, “Start here” signals, and “Task views” before exposing setup panels.
- Board, list, timeline, and calendar should be the fast-switch views users see first.
- Workload, dependency, gallery, grouping, filtering, sorting, and saved views should sit behind “Customize view” so complexity is available but not imposed.
- Users can switch the same tasks between board, list/table, timeline, calendar, Gantt, workload, dependencies, and gallery layouts.
- Users can group board cards by status, time period, milestone, workflow step, workstream, priority, or type.
- Users can save the current layout/filter/grouping state as a private view.
- Users can load previously saved planning views from the workbench and keep project-scoped views separate from workspace-wide views.
- Cards and rows must navigate to an editable task detail surface.
- Timeline views should make start/end dates, overlaps, and schedule gaps scannable.
- Gantt views should connect the work breakdown, start/due dates, milestone markers, progress, dependency counts, and critical schedule signals in one readable schedule.
- Dependency views should make parent links, blockers, and related tasks visible without opening each task.
- Project pages should always cross-link to planning, documents, time, reports, and task creation with project context preserved.
- Definition forms should create real persisted records for time periods, milestones, workflow steps, and workstreams.

## API Model

Prefer neutral endpoints and fields:

- `GET /api/v1/planning`
- `GET /api/v1/reports/planning-summary`
- `effortPoints`, `periodId`, `periodName`, `periodGoal`, `intakeGroup`, and `milestoneName`
- `currentPeriod`, `byPeriod`, `byIntakeGroup`, `byMilestone`, and `effortPointsTotal`

## Validation Checklist

Run the standard validation loop in `docs/implementation/validation-loop.md`, then manually check:

- `/app/planning` renders with no red Observable/runtime errors.
- Layout switching between board, table, timeline, calendar, workload, dependencies, and gallery works without content overlap.
- The initial Planning page shows task creation, Start here, Task view quick tabs, and Customize view without horizontal overflow on desktop or mobile.
- Grouping by status, time period, milestone, workflow step, and workstream renders useful columns.
- Moving a card updates the underlying task.
- Saving and loading a planning view preserves layout, grouping, scope, sort, and search state.
- “Create task”, “Define time period”, “Define milestone”, “Define workflow step”, and “Define workstream” create persisted records.
- `GET /api/v1/planning` returns canonical planning summary fields.

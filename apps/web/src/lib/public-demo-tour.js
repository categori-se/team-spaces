// @ts-check

/** @param {unknown} value */
function normalized(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[_\s]+/g, "-");
}

/**
 * Chooses the public demo project that best tells the seeded onboarding story.
 * An explicit project stays authoritative even when it is not in the current page.
 *
 * @param {Array<Record<string, unknown>>} projects
 * @param {{requestedProjectId?: string, isPublicDemo?: boolean}} [options]
 */
export function meetingTourProjectId(projects = [], {requestedProjectId = "", isPublicDemo = false} = {}) {
  if (requestedProjectId) return requestedProjectId;
  if (!isPublicDemo || !projects.length) return "";

  const onboardingProject = projects.find((project) => {
    const identity = `${project.id ?? ""} ${project.name ?? ""}`.toLowerCase();
    return identity.includes("mobile") && identity.includes("onboard");
  });
  const watchProject = projects.find((project) => normalized(project.health) === "watch");
  return String((onboardingProject ?? watchProject ?? projects[0])?.id ?? "");
}

/** @param {Record<string, unknown>} meeting */
function hasMeetingRecord(meeting) {
  if (String(meeting?.minutes ?? "").trim()) return true;
  if (!Array.isArray(meeting?.agendaItems)) return false;
  const agendaItems = /** @type {Array<Record<string, unknown>>} */ (meeting.agendaItems);
  return agendaItems.some((item) => String(item?.outcome ?? "").trim());
}

/**
 * Chooses the most instructive public demo meeting while keeping explicit deep
 * links authoritative and leaving the new-meeting disclosure unobstructed.
 *
 * @param {Array<Record<string, unknown>>} meetings
 * @param {{requestedMeetingId?: string, isPublicDemo?: boolean, newMeetingRequested?: boolean}} [options]
 */
export function meetingTourMeetingId(meetings = [], {
  requestedMeetingId = "",
  isPublicDemo = false,
  newMeetingRequested = false
} = {}) {
  if (requestedMeetingId) return requestedMeetingId;
  if (!isPublicDemo || newMeetingRequested || !meetings.length) return "";

  const inProgress = meetings.find((meeting) => normalized(meeting.status) === "in-progress");
  const recorded = meetings.find(hasMeetingRecord);
  const open = meetings.find((meeting) => normalized(meeting.status) === "open");
  return String((inProgress ?? recorded ?? open ?? meetings[0])?.id ?? "");
}

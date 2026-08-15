// @ts-check

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const landing = readFileSync(new URL("../src/index.md", import.meta.url), "utf8");
const overviewPage = readFileSync(new URL("../src/app.md", import.meta.url), "utf8");
const documentsPage = readFileSync(new URL("../src/app/documents.md", import.meta.url), "utf8");
const projectPage = readFileSync(new URL("../src/app/project.md", import.meta.url), "utf8");
const destinationPages = {
  overview: overviewPage,
  planning: readFileSync(new URL("../src/app/planning.md", import.meta.url), "utf8"),
  meetings: readFileSync(new URL("../src/app/meetings.md", import.meta.url), "utf8"),
  projects: readFileSync(new URL("../src/app/projects.md", import.meta.url), "utf8"),
  documents: documentsPage,
  reports: readFileSync(new URL("../src/app/reports.md", import.meta.url), "utf8"),
  "team-workflows": readFileSync(new URL("../src/app/admin.md", import.meta.url), "utf8")
};

test("landing offers an accessible no-account demo and a distinct real sign-in", () => {
  assert.match(landing, /^---\ntitle: Team Spaces\nsidebar: false\n---/);
  assert.match(
    landing,
    /<h1><span id="landing-title">Team Spaces<\/span><\/h1>/,
  );
  assert.doesNotMatch(landing, /<h1[^>]*id=/);
  assert.match(landing, /href="\/app#public-demo-entry"[^>]*data-public-demo-link/);
  assert.match(landing, /<h2><span id="landing-demo-title">Follow the work from focus to follow-up<\/span><\/h2>/);
  assert.doesNotMatch(landing, /<h2[^>]*id=/);
  assert.match(landing, /<nav class="landing-tour" aria-label="Explore the public demo">/);
  const primaryCards = [...landing.matchAll(/<a class="landing-tour__card" href="([^"]+)" data-public-demo-destination="([^"]+)">/g)]
    .map(([, href, destination]) => ({href, destination}));
  assert.deepEqual(primaryCards, [
    {href: "/app#public-demo-entry", destination: "overview"},
    {href: "/app/planning#public-demo-entry", destination: "planning"},
    {href: "/app/meetings#public-demo-entry", destination: "meetings"}
  ]);
  assert.match(landing, /<nav class="landing-demo__more" aria-label="More public demo areas">\s*<p><small>/);
  const secondaryDestinations = [
    ["projects", "/app/projects#public-demo-entry"],
    ["documents", "/app/documents#public-demo-entry"],
    ["reports", "/app/reports#public-demo-entry"],
    ["team-workflows", "/app/admin#public-demo-entry"]
  ];
  for (const [destination, href] of secondaryDestinations) {
    assert.ok(landing.includes(`href="${href}" data-public-demo-destination="${destination}"`));
  }
  for (const page of Object.values(destinationPages)) {
    assert.match(page, /id="public-demo-entry" hidden/);
  }
  assert.doesNotMatch(landing, /landing-feature-grid|<article>/);
  assert.match(landing, /Open Overview/);
  assert.match(landing, /Open Planning/);
  assert.match(landing, /Open Meetings/);
  assert.match(landing, /Documents <span>\(sample previews; file transfers disabled\)<\/span>/);
  assert.match(landing, /Team &amp; workflows/);
  assert.match(overviewPage, /id="public-demo-entry"[^>]*hidden/);
  assert.match(landing, /data-workspace-sign-in>Sign in/);
  assert.match(landing, /aria-describedby="public-demo-disclosure"/);
  assert.match(landing, /No account needed/);
  assert.match(landing, /A demo visitor and four fictional teammates/i);
  assert.match(landing, /Sam Okafor/);
  assert.match(landing, /5 people · shared assignments/);
  assert.match(landing, /assigned work/i);
  assert.match(landing, /Changes are shared and reset daily/);
  assert.match(landing, /Do not enter sensitive or personal information/);
  assert.match(landing, /href="LICENSE\.txt" download>Apache 2\.0 license<\/a>/);
  assert.match(landing, /href="THIRD_PARTY_NOTICES\.txt" download>Third-party software notices<\/a>/);
  assert.match(landing, /enterPublicDemo/);
  assert.match(landing, /beginSignIn/);
  assert.match(landing, /currentSession\(\)\.catch/);
  assert.match(landing, /workspaceSignIn\.remove\(\)/);
  assert.match(landing, /publicDemoTour\.remove\(\)/);
  assert.match(landing, /publicDemoDisclosure\.remove\(\)/);
  assert.match(landing, /workspaceSignIn\.classList\.remove\("button--ghost"\)/);
  assert.match(landing, /workspaceSignIn\.classList\.add\("button--primary"\)/);
});

test("planning keeps the core workbench prominent and progressively discloses secondary tools", () => {
  const planningPage = destinationPages.planning;
  assert.match(planningPage, /actions:\s*\[\s*buttonLink\("New task", "#new-task", \{primary: true\}\)\s*\]/);
  assert.doesNotMatch(planningPage, /buttonLink\("View options"/);
  assert.match(planningPage, /display\(planningWorkbench\(/);
  assert.match(planningPage, /display\(actionPanel\("Create task"/);
  assert.match(planningPage, /actionPanel\("Planning setup", toolbar\(\[/);
  assert.match(planningPage, /actionPanel\("Planning insights", toolbar\(\[/);
  for (const panel of ["Define time period", "Define milestone", "Define workflow step", "Define workstream", "Period plan"]) {
    assert.match(planningPage, new RegExp(`actionPanel\\("${panel}"`));
  }
  for (const panel of ["Period health", "Status board", "Intake groups", "Team workload", "Milestone board"]) {
    assert.match(planningPage, new RegExp(`actionPanel\\("${panel}"`));
  }
});

test("documents replace public-demo upload controls with a clear boundary notice", () => {
  assert.match(documentsPage, /client\.isPublicDemo\s*\? \[buttonLink\("Filter library"/);
  assert.match(documentsPage, /client\.isPublicDemo\s*\? publicDemoUploadNotice\(\)/);
  assert.match(documentsPage, /: toolbar\(\[\s*actionPanel\("Upload document"/);
  assert.match(projectPage, /client\.isPublicDemo \? "" : actionPanel\("Upload document"/);
  assert.match(projectPage, /if \(client\.isPublicDemo\) display\(publicDemoUploadNotice\(\)\)/);
});

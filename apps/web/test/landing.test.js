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

test("landing represents Team Spaces and routes visitors to project selection", () => {
  assert.match(landing, /^---\ntitle: Team Spaces\nsidebar: false\n---/);
  assert.match(landing, /<h1><span id="landing-title">Team Spaces<\/span><\/h1>/);
  assert.match(landing, /href="\/projects">Browse public projects/);
  assert.match(landing, /href="\/app\/projects" data-workspace-sign-in>Sign in to your workspace/);
  assert.match(landing, /projects, tasks, roadmaps and decisions/);
  assert.match(landing, /workspaceSignIn.textContent = "Open workspace"/);
  assert.match(landing, /href="LICENSE\.txt" download>Apache 2\.0 license<\/a>/);
  assert.match(landing, /beginSignIn/);
  assert.doesNotMatch(landing, /OpenGeo|opengeo|enterPublicDemo|fictional|sample data|data-public-demo/);
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

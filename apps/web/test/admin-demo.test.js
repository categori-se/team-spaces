// @ts-check

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const adminPage = readFileSync(new URL("../src/app/admin.md", import.meta.url), "utf8");

function between(start, end) {
  const from = adminPage.indexOf(start);
  const to = adminPage.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return adminPage.slice(from, to);
}

test("public demo settings expose useful sample sections and explain private boundaries", () => {
  assert.match(adminPage, /id="public-demo-entry" hidden/);
  assert.match(adminPage, /label: client\.isPublicDemo \? "Data & activity" : "Data & audit"/);
  assert.match(adminPage, /Accounts, Profile, Security, and member changes are disabled in the shared demo/);
  assert.match(adminPage, /Sign in to a private workspace to manage identity, access, and protected settings/);
  assert.match(adminPage, /publicDemoFallback/);
  assert.match(adminPage, /history\.replaceState\(history\.state, "", canonicalUrl\)/);
  assert.match(adminPage, /publicDemoTeamOverview/);
  assert.match(adminPage, /Who is doing what|Role and project access/);
  assert.match(adminPage, /workConfigurationSummary/);
  assert.match(adminPage, /Advanced · safe to edit · resets daily/);
  assert.match(adminPage, /Sample document metadata/);
  assert.match(adminPage, /file transfers off/);
});

test("settings load identity first and only request data for the active section", () => {
  const teamLoader = between('if (section === "team")', 'if (section === "accounts")');
  assert.match(teamLoader, /client\.memberships\.list/);
  assert.match(teamLoader, /client\.projects\.list/);
  assert.match(teamLoader, /client\.workItems\.list\(project\.id, \{limit: 10/);
  assert.match(teamLoader, /\.flatMap\(\(page\) => page\.items\)/);
  assert.doesNotMatch(teamLoader, /client\.(accounts|workspace|activity|documents|applicationData|workConfiguration)/);

  const accountLoader = between('if (section === "accounts")', 'if (section === "workflow")');
  assert.match(accountLoader, /client\.accounts\.list/);
  assert.match(accountLoader, /client\.workspace\.get/);
  assert.doesNotMatch(accountLoader, /client\.(memberships|projects|activity|documents|applicationData|workConfiguration)/);

  const workflowLoader = between('if (section === "workflow")', 'if (section === "security")');
  assert.match(workflowLoader, /client\.workConfiguration\.get/);
  assert.doesNotMatch(workflowLoader, /Promise\.all/);

  const publicDataLoader = between("if (client.isPublicDemo) {", "const [memberships, projects, activity, documents, applicationData]");
  assert.match(publicDataLoader, /client\.activity\.list/);
  assert.match(publicDataLoader, /client\.documents\.list/);
  assert.match(publicDataLoader, /client\.applicationData\.summary/);
  assert.doesNotMatch(publicDataLoader, /client\.(memberships|projects|accounts|workspace|workConfiguration)/);

  assert.match(adminPage, /const me = await client\.me/);
  assert.match(adminPage, /const sectionData = await loadSettingsSection\(section\)/);
});

test("public demo data opens activity first without exposing member controls", () => {
  assert.match(adminPage, /actionPanel\("Recent activity"[\s\S]*?\{open: true, id: "activity"/);
  assert.match(adminPage, /if \(!client\.isPublicDemo\) \{\s*dataPanels\.unshift\(actionPanel\("Members"/);
  assert.match(adminPage, /const canManageWorkspace = isAdmin && !client\.isPublicDemo/);
  assert.match(adminPage, /canManageWorkspace\s*\? teamManagementPanel/);
});

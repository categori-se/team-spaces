import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {
  collaborationActions,
  createNotebookResource,
  workspaceContractsVersion
} from "../src/index.js";

test("Team Spaces exposes the shared workspace contract through its contracts package", () => {
  const notebook = createNotebookResource({
    notebookId: "notebook_team_spaces",
    workspaceId: "workspace_team_spaces",
    projectId: "project_team_spaces",
    creatorId: "user_owner",
    now: new Date("2026-08-28T12:00:00Z")
  });
  const manifest = JSON.parse(readFileSync(new URL("../../workspace-contracts/package.json", import.meta.url)));
  assert.equal(workspaceContractsVersion, manifest.version);
  assert.equal(notebook.owner_id, "user_owner");
  assert.equal(collaborationActions.execute, "execute");
});

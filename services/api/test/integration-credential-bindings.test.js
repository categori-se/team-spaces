// @ts-nocheck

import assert from "node:assert/strict";
import test from "node:test";
import {environmentCredentialResolver, integrationCredentialBinding, ProviderIntegrationRuntime} from "../src/integrations/provider-adapters.js";
import {MemoryRepository} from "../src/repositories/memory.js";
import {DynamoRepository} from "../src/repositories/dynamo.js";

const connector = {id: "build-board", type: "github", enabled: true, credentialReference: "builds", baseUrl: "https://api.github.test", projectId: "project-one", repository: "team/product"};
const workspaceId = "workspace-owner";
const binding = integrationCredentialBinding(workspaceId, connector);
const resolver = () => environmentCredentialResolver({INTEGRATION_CREDENTIALS_JSON: JSON.stringify({builds: {accessToken: "provider-test-token", bindings: [binding]}})});

test("bound credentials resolve only for a complete matching workspace and connector", async () => {
  const resolve = resolver();
  const reordered = Object.fromEntries(Object.entries(connector).reverse());
  assert.deepEqual(await resolve("builds", {workspaceId, connector: reordered}), {accessToken: "provider-test-token"});
  await assert.rejects(() => resolve("builds"), /trusted workspace and connector/);
  await assert.rejects(() => resolve("builds", {workspaceId, connector: {}}), /trusted workspace and connector/);
});

test("another workspace cannot borrow a credential by copying its reference and connector", async () => {
  await assert.rejects(() => resolver()("builds", {workspaceId: "workspace-other", connector: {...connector, workspaceId}}), /not permitted/);
});

test("credential bindings reject changes to provider destinations and data scope", async () => {
  for (const patch of [
    {baseUrl: "https://attacker.test"}, {apiBaseUrl: "https://attacker.test"},
    {tokenEndpoint: "https://attacker.test/token"}, {authMode: "oidc-token-exchange"},
    {repository: "team/private-other"}, {projectId: "project-other"},
    {githubProjectId: "different-board"}, {sharedRepositories: ["team/other"]},
    {id: "other-connector"}, {healthPath: "repos/team/private-other"}
  ]) {
    await assert.rejects(() => resolver()("builds", {workspaceId, connector: {...connector, ...patch}}), /not permitted/);
  }
});

test("malformed and empty binding policies fail closed", async () => {
  for (const bindings of [[], {}, [null], [{workspaceId, connectorId: connector.id, configurationSha256: "*"}], Array(101).fill(binding)]) {
    const resolve = environmentCredentialResolver({INTEGRATION_CREDENTIALS_JSON: JSON.stringify({builds: {accessToken: "provider-test-token", bindings}})});
    await assert.rejects(() => resolve("builds", {workspaceId, connector}), /bindings are invalid/);
  }
});

test("both repositories attach the trusted workspace before any provider request", async () => {
  for (const Repository of [MemoryRepository, DynamoRepository]) {
    let requests = 0;
    const runtime = new ProviderIntegrationRuntime({resolveCredential: resolver(), fetchImpl: async (_url, init) => {
      requests += 1;
      assert.equal(init.headers.authorization, "Bearer provider-test-token");
      return new Response("{}", {status: 200, headers: {"content-type": "application/json"}});
    }});
    const repository = Repository === MemoryRepository ? new Repository(undefined, {integrationRuntime: runtime}) : new Repository({tableName: "table-one", integrationRuntime: runtime});
    repository.getWorkspaceCapabilities = async () => ({connectors: [{...connector, workspaceId}]});
    await assert.rejects(() => repository.checkIntegrationHealth({workspaceId: "workspace-other"}, connector.id), /not permitted/);
    assert.equal(requests, 0);
    assert.equal((await repository.checkIntegrationHealth({workspaceId}, connector.id)).ok, true);
    assert.equal(requests, 1);
  }
});

test("a caller without connector context cannot reuse a bound provider credential", async () => {
  await assert.rejects(() => resolver()("builds"), /trusted workspace and connector/);
});

test("legacy unbound credentials remain available for trusted local installations", async () => {
  const resolve = environmentCredentialResolver({INTEGRATION_CREDENTIALS_JSON: JSON.stringify({local: {username: "local-service", password: "local-test-password"}})});
  const value = await resolve("local");
  value.password = "modified-copy";
  assert.equal((await resolve("local")).password, "local-test-password");
});

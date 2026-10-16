// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import {PutCommand} from "@aws-sdk/lib-dynamodb";
import {DynamoRepository} from "../src/repositories/dynamo.js";

class ReplayDocumentClient {
  constructor() {
    this.claims = new Set();
    this.commands = [];
  }

  async send(command) {
    this.commands.push(command);
    if (command instanceof PutCommand && String(command.input.Item?.SK).startsWith("PROVIDER_DELIVERY#") && command.input.ConditionExpression) {
      const key = `${command.input.Item.PK}:${command.input.Item.SK}`;
      if (this.claims.has(key)) {
        const error = new Error("duplicate");
        error.name = "ConditionalCheckFailedException";
        throw error;
      }
      this.claims.add(key);
    }
    return {};
  }
}

test("Dynamo provider delivery claims reject replay before duplicate mutations", async () => {
  const client = new ReplayDocumentClient();
  const integrationRuntime = {
    verifyWebhook: async () => ({deliveryId: "delivery-1", eventType: "pull_request.opened", externalId: "team/repo#42", externalUrl: "https://github.test/team/repo/pull/42", title: "Finish TS#work-one", summary: "opened", workItemIds: ["work-one"], payload: {state: "open"}})
  };
  const repository = new DynamoRepository({tableName: "table-one", documentClient: client, integrationRuntime});
  repository.now = () => "2026-08-27T12:00:00.000Z";
  repository.configuredConnector = async () => ({id: "github", type: "github", enabled: true, projectId: "project-one"});
  repository.getProject = async () => ({id: "project-one"});
  repository.listWorkItems = async () => [{id: "work-one", projectId: "project-one"}];
  let linkCalls = 0;
  repository.createIntegrationLink = async (_context, input) => {
    linkCalls += 1;
    return {id: "link-one", ...input};
  };
  repository.ingestIntegrationEvent = async () => ({id: "activity-one"});
  const context = {workspaceId: "workspace-one", actorId: "provider-github", correlationId: "test", membership: {role: "workspace-admin"}};

  const first = await repository.receiveProviderWebhook(context, "github", {headers: {}, rawBody: "{}"});
  const second = await repository.receiveProviderWebhook(context, "github", {headers: {}, rawBody: "{}"});
  assert.equal(first.linkedCount, 1);
  assert.equal(second.duplicate, true);
  assert.equal(linkCalls, 1);
  const claim = client.commands.find((command) => command instanceof PutCommand && command.input.ConditionExpression);
  assert.match(claim.input.ConditionExpression, /attribute_not_exists/);
  assert.equal(Number.isInteger(claim.input.Item.expiresAt), true);
});

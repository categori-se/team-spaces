// @ts-nocheck

import {DynamoDBClient} from "@aws-sdk/client-dynamodb";
import {DynamoDBDocumentClient, GetCommand, UpdateCommand} from "@aws-sdk/lib-dynamodb";
import {ServiceUnavailableError, TooManyRequestsError} from "../errors.js";
import {
  assertPublicDemoSlot,
  publicDemoMetadata,
  publicDemoMutationLimit,
  publicDemoPointerKey,
  publicDemoWorkspaceId
} from "./public-demo.js";

const defaultDocumentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export class DynamoPublicDemoControl {
  /**
   * @param {{tableName: string, documentClient?: any, mutationLimit?: number, clock?: () => Date}} options
   */
  constructor(options) {
    if (!options?.tableName) throw new Error("A public demo table name is required");
    this.tableName = options.tableName;
    this.documentClient = options.documentClient ?? defaultDocumentClient;
    this.mutationLimit = options.mutationLimit ?? Number(process.env.PUBLIC_DEMO_MUTATION_LIMIT ?? publicDemoMutationLimit);
    this.clock = options.clock ?? (() => new Date());
  }

  async getActive() {
    const result = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: publicDemoPointerKey,
      ConsistentRead: true
    }));
    if (!result.Item) throw new ServiceUnavailableError("The shared demo is being prepared. Please try again shortly.");
    let slot;
    try {
      slot = assertPublicDemoSlot(result.Item.activeSlot);
    } catch {
      throw new ServiceUnavailableError("The shared demo is being prepared. Please try again shortly.");
    }
    const workspaceId = publicDemoWorkspaceId(slot);
    if (result.Item.workspaceId && result.Item.workspaceId !== workspaceId) {
      throw new ServiceUnavailableError("The shared demo configuration is invalid.");
    }
    return {
      activeSlot: slot,
      workspaceId,
      resetAt: result.Item.resetAt,
      nextResetAt: result.Item.nextResetAt,
      resetDate: result.Item.resetDate,
      seedVersion: result.Item.seedVersion,
      version: Number(result.Item.version ?? 1)
    };
  }

  /**
   * @param {{kind?: string, cap?: number}} policy
   * @param {{workspaceId: string}} active
   */
  async claimMutation(policy, active) {
    const now = this.clock();
    const date = active.resetDate ?? now.toISOString().slice(0, 10);
    const counterName = `created_${String(policy.kind ?? "other").replace(/[^A-Za-z0-9_]/g, "_")}`;
    const names = {"#total": "total", "#updatedAt": "updatedAt", "#expiresAt": "expiresAt"};
    const values = {
      ":one": 1,
      ":limit": this.mutationLimit,
      ":updatedAt": now.toISOString(),
      ":expiresAt": Math.floor(now.getTime() / 1000) + 3 * 24 * 60 * 60
    };
    let condition = "(attribute_not_exists(#total) OR #total < :limit)";
    let update = "SET #updatedAt = :updatedAt, #expiresAt = :expiresAt ADD #total :one";
    if (policy.cap !== undefined) {
      names["#counter"] = counterName;
      values[":entityLimit"] = policy.cap;
      condition += " AND (attribute_not_exists(#counter) OR #counter < :entityLimit)";
      update += ", #counter :one";
    }
    try {
      await this.documentClient.send(new UpdateCommand({
        TableName: this.tableName,
        Key: {PK: `WORKSPACE#${active.workspaceId}`, SK: `PUBLIC_DEMO_QUOTA#${date}`},
        UpdateExpression: update,
        ConditionExpression: condition,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values
      }));
    } catch (error) {
      if (error?.name === "ConditionalCheckFailedException") {
        throw new TooManyRequestsError("The shared demo has reached its daily edit limit. It will reset automatically.");
      }
      throw error;
    }
    return true;
  }

  /** @param {any} active */
  metadata(active) {
    return publicDemoMetadata(active, this.clock());
  }
}

export function createDynamoPublicDemoControlFromEnv() {
  return new DynamoPublicDemoControl({
    tableName: process.env.TABLE_NAME,
    mutationLimit: Number(process.env.PUBLIC_DEMO_MUTATION_LIMIT ?? publicDemoMutationLimit)
  });
}

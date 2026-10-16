// @ts-check

import {requestResetOnAccess} from "./on-demand-reset.js";
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
   * @param {{tableName: string, documentClient?: Pick<DynamoDBDocumentClient, "send">, mutationLimit?: number, clock?: () => Date, resetFunctionName?: string, invokeReset?: () => Promise<unknown>}} options
   */
  constructor(options) {
    if (!options?.tableName) throw new Error("A public demo table name is required");
    this.tableName = options.tableName;
    this.documentClient = options.documentClient ?? defaultDocumentClient;
    this.mutationLimit = options.mutationLimit ?? Number(process.env.PUBLIC_DEMO_MUTATION_LIMIT ?? publicDemoMutationLimit);
    this.clock = options.clock ?? (() => new Date());
    this.resetFunctionName = options.resetFunctionName ?? process.env.PUBLIC_DEMO_RESET_FUNCTION_NAME;
    this.invokeReset = options.invokeReset ?? (async () => {
      const {LambdaClient, InvokeCommand} = await import("@aws-sdk/client-lambda");
      const result = await new LambdaClient({}).send(new InvokeCommand({FunctionName:this.resetFunctionName,InvocationType:"Event",Payload:JSON.stringify({source:"teamspaces.public-demo-access"})}));
      if(result.StatusCode!==202)throw new Error("Demo reset was not accepted");
    });
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
    if (this.resetFunctionName) {
      const now = this.clock().getTime();
      const pointerVersion = Number(result.Item.version ?? 1);
      const pending = await requestResetOnAccess({pointer:result.Item,now,invoke:this.invokeReset,claim:leaseUntil=>this.documentClient.send(new UpdateCommand({
        TableName:this.tableName,Key:publicDemoPointerKey,
        UpdateExpression:"SET #lease = :lease",
        ConditionExpression:"#version = :version AND (attribute_not_exists(#lease) OR #lease <= :now)",
        ExpressionAttributeNames:{"#version":"version","#lease":"resetLeaseUntil"},
        ExpressionAttributeValues:{":version":pointerVersion,":lease":leaseUntil,":now":now}
      }))});
      if(pending)throw new ServiceUnavailableError("The shared demo is refreshing after its reset deadline. Please try again shortly.");
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
   * @param {{workspaceId: string, resetDate?: string}} active
   */
  async claimMutation(policy, active) {
    const now = this.clock();
    const date = active.resetDate ?? now.toISOString().slice(0, 10);
    const counterName = `created_${String(policy.kind ?? "other").replace(/[^A-Za-z0-9_]/g, "_")}`;
    /** @type {Record<string, string>} */
    const names = {"#total": "total", "#updatedAt": "updatedAt", "#expiresAt": "expiresAt"};
    /** @type {Record<string, string | number>} */
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
      if (error && typeof error === "object" && "name" in error && error.name === "ConditionalCheckFailedException") {
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
  const tableName = process.env.TABLE_NAME;
  if (!tableName) throw new Error("A public demo table name is required");
  return new DynamoPublicDemoControl({
    tableName,
    mutationLimit: Number(process.env.PUBLIC_DEMO_MUTATION_LIMIT ?? publicDemoMutationLimit)
  });
}

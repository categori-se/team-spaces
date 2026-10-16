// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import {defaultWorkspaceCapabilities} from "@teamspaces/contracts";
import {createHandler} from "../src/handler.js";
import {encodeLdapFilter, escapeLdapFilterValue, LdapDirectoryRuntime} from "../src/directory/ldap.js";
import {issueLdapSession, unverifiedLdapSession, verifyLdapSession} from "../src/directory/ldap-session.js";
import {MemoryRepository} from "../src/repositories/memory.js";

test("encodes bounded LDAP filters and escapes assertion values", () => {
  assert.equal(escapeLdapFilterValue("a*(b)\\\0"), "a\\2a\\28b\\29\\5c\\00");
  const encoded = encodeLdapFilter("(&(objectClass=person)(uid=alex\\2a))");
  assert.equal(encoded[0], 0xa0);
  assert.equal(encodeLdapFilter("(cn=prefix*)")[0], 0xa4);
  assert.equal(encodeLdapFilter("(accountExpires>=1)")[0], 0xa5);
  assert.throws(() => encodeLdapFilter("(invalid attribute=value)"), /filter is invalid/);
});

test("performs service search then user bind without retaining the password", async () => {
  const calls = [];
  const connection = {
    connect: async () => calls.push("connect"),
    bind: async (dn, password) => calls.push({dn, password}),
    search: async (options) => {
      calls.push(options);
      return [{dn: "uid=alex,ou=people,dc=example,dc=test", attributes: {uid: ["alex"], mail: ["alex@example.test"], givenname: ["Alex"], sn: ["Morgan"], displayname: ["Alex Morgan"], memberof: ["cn=delivery,ou=groups,dc=example,dc=test"]}}];
    },
    close: () => calls.push("close")
  };
  const runtime = new LdapDirectoryRuntime({resolveCredential: async () => ({bindDn: "cn=reader", bindPassword: "reader-password"}), connectionFactory: () => connection});
  const configuration = {host: "ldaps://directory.example.test", baseDn: "ou=people,dc=example,dc=test", bindCredentialReference: "ldap", userFilter: "(objectClass=person)"};
  const user = await runtime.authenticate(configuration, {username: "alex", password: "user-password"});
  assert.equal(user.email, "alex@example.test");
  assert.equal(user.name, "Alex Morgan");
  assert.deepEqual(calls.filter((call) => typeof call === "object" && "dn" in call), [{dn: "cn=reader", password: "reader-password"}, {dn: user.externalId, password: "user-password"}]);
  assert.equal(calls.at(-1), "close");
});

test("issues workspace-bound expiring LDAP sessions and rejects tampering", () => {
  const credential = {sessionSigningKey: "a-secure-signing-key-with-more-than-32-bytes"};
  const now = Date.parse("2026-08-27T12:00:00.000Z");
  const token = issueLdapSession({workspaceId: "workspace-default", user: {externalId: "uid=alex", email: "alex@example.test", name: "Alex"}, credential, now, lifetimeSeconds: 900});
  assert.equal(unverifiedLdapSession(token.access_token).workspaceId, "workspace-default");
  assert.equal(verifyLdapSession(token.access_token, credential, {workspaceId: "workspace-default", now: now + 1000}).email, "alex@example.test");
  assert.throws(() => verifyLdapSession(`${token.access_token.slice(0, -1)}x`, credential, {workspaceId: "workspace-default", now}), /invalid or expired/);
  assert.throws(() => verifyLdapSession(token.access_token, credential, {workspaceId: "other", now}), /invalid or expired/);
  assert.throws(() => verifyLdapSession(token.access_token, credential, {workspaceId: "workspace-default", now: now + 901000}), /invalid or expired/);
});

function requestEvent(method, path, body, headers = {}) {
  return {rawPath: path, headers, requestContext: {http: {method}}, body: body === undefined ? undefined : JSON.stringify(body)};
}

async function request(handler, method, path, body, headers = {}) {
  const response = await handler(requestEvent(method, path, body, headers));
  return {response, payload: response.body ? JSON.parse(response.body) : undefined};
}

test("authenticates LDAP users into a protected API session and queries scheduled sync data", async () => {
  process.env.ALLOW_DEMO_AUTH = "true";
  process.env.APP_ORIGIN = "http://localhost:3000";
  const credential = {bindDn: "cn=reader", bindPassword: "reader-password", sessionSigningKey: "a-secure-signing-key-with-more-than-32-bytes"};
  let directoryUsers = [{externalId: "uid=alex,ou=people,dc=example,dc=test", email: "alex@example.test", name: "Alex Morgan", status: "active", department: "Delivery", groupDns: ["cn=delivery,ou=groups,dc=example,dc=test"]}];
  const ldapRuntime = {
    credential: async () => credential,
    authenticate: async (_configuration, input) => {
      assert.deepEqual(input, {username: "alex", password: "correct-password"});
      return directoryUsers[0];
    },
    synchronize: async () => ({users: directoryUsers, groups: [{externalId: "cn=delivery,ou=groups,dc=example,dc=test", name: "Delivery", memberDns: directoryUsers.map((user) => user.externalId)}]})
  };
  const repository = new MemoryRepository();
  const handler = createHandler({repository, ldapRuntime});
  const capabilities = structuredClone(defaultWorkspaceCapabilities);
  capabilities.authentication.ldap = {enabled: true, host: "ldaps://directory.example.test", baseDn: "ou=people,dc=example,dc=test", bindCredentialReference: "ldap", syncGroups: true, groupBaseDn: "ou=groups,dc=example,dc=test", defaultRole: "viewer", departmentAttribute: "department"};
  const demoHeaders = {origin: "http://localhost:3000", "x-demo-user-id": "user-demo-admin", "x-demo-user-email": "admin@team-spaces.example"};
  assert.equal((await request(handler, "PATCH", "/api/v1/capabilities", capabilities, demoHeaders)).response.statusCode, 200);

  const login = await request(handler, "POST", "/api/v1/ldap-auth/workspace-default", {username: "alex", password: "correct-password"}, {origin: "http://localhost:3000"});
  assert.equal(login.response.statusCode, 201);
  const token = login.payload.data.access_token;
  const me = await request(handler, "GET", "/api/v1/ldap/workspace-default/me", undefined, {origin: "http://localhost:3000", authorization: `Bearer ${token}`});
  assert.equal(me.response.statusCode, 200);
  assert.equal(me.payload.data.user.email, "alex@example.test");
  assert.equal((await request(handler, "GET", "/api/v1/ldap/workspace-default/me", undefined, {origin: "http://localhost:3000", authorization: "Bearer invalid"})).response.statusCode, 401);

  const synchronized = await request(handler, "POST", "/api/v1/directory/ldap/sync", {}, demoHeaders);
  assert.equal(synchronized.payload.data.synchronizedCount, 1);
  assert.equal(synchronized.payload.data.groups[0].name, "Delivery");
  const updatedCapabilities = await repository.getWorkspaceCapabilities({workspaceId: "workspace-default"});
  assert.equal(updatedCapabilities.groups.some((group) => group.managedBy === "ldap"), true);
  assert.equal(updatedCapabilities.departments.some((department) => department.name === "Delivery"), true);

  directoryUsers = [];
  const second = await request(handler, "POST", "/api/v1/directory/ldap/sync", {}, demoHeaders);
  assert.equal(second.payload.data.disabledCount, 1);
  const memberships = await repository.listMemberships({workspaceId: "workspace-default"});
  assert.equal(memberships.find((member) => member.email === "alex@example.test").status, "disabled");
});

// @ts-nocheck

import {createHash, createHmac, randomBytes, timingSafeEqual} from "node:crypto";
import {mkdir, open, readFile, rename, lstat} from "node:fs/promises";
import path from "node:path";
import {parseProjectInput, parseWorkItemInput, parseWorkItemPatchInput, roles} from "@teamspaces/contracts";
import {MemoryRepository} from "./repositories/memory.js";

const stateLimit = 16 * 1024 * 1024;
const json = value => JSON.stringify(value);
const fingerprint = value => createHash("sha256").update(json(value)).digest("hex");

async function privateRead(filename) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > stateLimit || info.mode & 0o077) throw new Error("Local coordination files must be private regular files");
  return readFile(filename, "utf8");
}

async function privateWrite(filename, value) {
  const temporary = `${filename}.${randomBytes(8).toString("hex")}.tmp`;
  const stream = await open(temporary, "wx", 0o600);
  try { await stream.writeFile(value); await stream.sync(); } finally { await stream.close(); }
  await rename(temporary, filename);
}

export function emptyCoordinationSeed(program) {
  const owner = program.owner;
  if (!owner || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(owner.id) || typeof owner.name !== "string" || !owner.name.trim()) throw new Error("The real program owner must be identified");
  const workspace = {id: program.workspace?.id ?? `workspace-${program.initiativeId}`, name: program.workspace?.name ?? "Project workspace", accountType: "team", version: 1, createdBy: owner.id};
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(workspace.id) || typeof workspace.name !== "string" || !workspace.name.trim() || workspace.name.length > 200) throw new Error("Provide a valid workspace identity independent of its projects");
  return {workspace, users: [{...owner}], memberships: [{userId: owner.id, workspaceId: workspace.id, name: owner.name, role: roles.admin, status: "active", defaultAccount: true, version: 1}], portfolios: [], projects: [], workItems: [], meetings: [], documents: [], timeEntries: [], activities: []};
}

/** Enroll the actual reviewed program once. Restart never replays an import. */
export async function materializeCoordinationProgram(program) {
  if (program.schemaVersion !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,100}$/.test(program.initiativeId ?? "") || typeof program.title !== "string" || !Array.isArray(program.projects) || !program.projects.length || program.projects.length > 20 || program.projects.filter(project => project.facet === "community").length > 10) throw new Error("A reviewed project program within the publication limits is required");
  const seed = emptyCoordinationSeed(program);
  const repository = new MemoryRepository(seed);
  const context = {actorId: program.owner.id, user: program.owner, workspaceId: seed.workspace.id, membership: seed.memberships[0], correlationId: "program-enrollment"};
  const projects = new Map();
  const taskIds = new Map();
  for (const source of program.projects) {
    if (typeof source.name !== "string" || !source.name.trim() || !["community", "internal"].includes(source.facet) || !Array.isArray(source.tasks) || source.tasks.length > 200) throw new Error("Project names, facets, and finite task scope must match the real program");
    const project = await repository.createProject(context, parseProjectInput({name: source.name, description: `Actual development pathway for ${source.name}.`, coordination: {initiativeId: program.initiativeId, facet: source.facet, key: source.key, repository: source.repository}}));
    if (projects.has(source.key)) throw new Error("Program project keys must be unique");
    projects.set(source.key, project);
    for (const task of source.tasks) {
      const coordination = {...task.coordination, sourceId: program.sourceId, taskKey: task.key, dependencies: []};
      const record = await repository.createWorkItem(context, project.id, parseWorkItemInput({...task, blockedBy: [], coordination}));
      const key = `${source.key}:${task.key}`;
      if (taskIds.has(key)) throw new Error("Program task keys must be unique within each project");
      taskIds.set(key, record.id);
    }
  }
  for (const source of program.projects) {
    const project = projects.get(source.key);
    for (const task of source.tasks) {
      const id = taskIds.get(`${source.key}:${task.key}`);
      const record = repository.workItems.get(id);
      const blockedBy = (task.blockedByKeys ?? []).map(key => {
        const dependency = taskIds.get(`${source.key}:${key}`);
        if (!dependency || dependency === id) throw new Error("Program prerequisite is missing or refers to itself");
        return dependency;
      });
      const dependencies = (task.coordination.dependencies ?? []).map(reference => {
        const targetProject = projects.get(reference.projectKey);
        const taskId = taskIds.get(`${reference.projectKey}:${reference.taskKey}`);
        if (!targetProject || !taskId || taskId === id) throw new Error("Connected program prerequisite is missing or refers to itself");
        return {projectId: targetProject.id, taskId};
      });
      if (blockedBy.length || dependencies.length) await repository.patchWorkItem(context, project.id, id, parseWorkItemPatchInput({version: record.version, blockedBy, coordination: {...record.coordination, dependencies}}));
    }
  }
  const community = [...projects.values()].filter(project => project.coordination.facet === "community");
  if (community.length) repository.publicCoordinationRegistrations.set(program.initiativeId, {initiativeId: program.initiativeId, title: community.length === 1 ? community[0].name : `${program.title} community projects`, workspaceId: seed.workspace.id, projectIds: community.map(project => project.id), parityBaseline: program.baselineSummary, enabled: true, version: 1, updatedAt: new Date().toISOString()});
  repository.coordinationProgram = {initiativeId: program.initiativeId, title: program.title, sourceRevision: program.sourceRevision, baselineSummary: program.baselineSummary, enrolledAt: new Date().toISOString()};
  return {repository, seed};
}

function snapshot(repository) {
  const maps = Object.fromEntries(Object.entries(repository).filter(([, value]) => value instanceof Map).map(([key, value]) => [key, [...value]]));
  return {schemaVersion: 1, workspace: repository.workspace, maps, activities: repository.activities, program: repository.coordinationProgram};
}

export async function openLocalCoordination({manifestPath, stateDirectory}) {
  if (!manifestPath || !stateDirectory) throw new Error("Select the real program manifest and a private state directory");
  const program = JSON.parse(await privateRead(path.resolve(manifestPath)));
  const directory = path.resolve(stateDirectory);
  await mkdir(directory, {recursive: true, mode: 0o700});
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || directoryInfo.mode & 0o077) throw new Error("The local state directory must be private");
  const filename = path.join(directory, "records.json");
  let repository;
  let restored = false;
  try {
    const state = JSON.parse(await privateRead(filename));
    if (state.schemaVersion !== 1 || state.workspace?.id !== emptyCoordinationSeed(program).workspace.id || state.program?.initiativeId !== program.initiativeId || !state.maps || !state.maps.users?.some(([id]) => id === program.owner.id)) throw new Error("The saved workspace does not match this program owner");
    repository = new MemoryRepository(emptyCoordinationSeed(program));
    for (const [key, entries] of Object.entries(state.maps)) {
      if (!(repository[key] instanceof Map) || !Array.isArray(entries)) throw new Error("The local workspace snapshot contains unsupported state");
      repository[key] = new Map(entries);
    }
    repository.workspace = state.workspace;
    repository.activities = state.activities;
    repository.coordinationProgram = state.program;
    restored = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    ({repository} = await materializeCoordinationProgram(program));
  }
  const save = () => privateWrite(filename, json(snapshot(repository)) + "\n");
  const legacyWorkspaceName = restored && repository.workspace.id === "workspace-opengeo" && repository.workspace.name === "OpenGeo Studio" && !program.workspace?.name;
  if (legacyWorkspaceName) {
    repository.workspace = {...repository.workspace, name: "Project workspace", version: Number(repository.workspace.version ?? 1) + 1};
    repository.workspaces.set(repository.workspace.id, {...repository.workspace});
  }
  if (!restored || legacyWorkspaceName) await save();
  const keyFile = path.join(directory, "owner-key");
  let ownerKey;
  try { ownerKey = (await privateRead(keyFile)).trim(); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    ownerKey = randomBytes(32).toString("hex");
    await privateWrite(keyFile, ownerKey + "\n");
  }
  if (!/^[a-f0-9]{64}$/.test(ownerKey)) throw new Error("The local owner key is invalid");
  const equal = value => typeof value === "string" && timingSafeEqual(Buffer.from(fingerprint(value)), Buffer.from(fingerprint(ownerKey)));
  const sign = value => createHmac("sha256", ownerKey).update(value).digest("base64url");
  const session = key => {
    if (!equal(key)) return undefined;
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(json({alg: "HS256", typ: "JWT"})).toString("base64url");
    const payload = Buffer.from(json({iss: "teamspaces-local", sub: program.owner.id, name: program.owner.name, workspaceId: repository.workspace.id, iat: now, exp: now + 28800})).toString("base64url");
    const token = `${header}.${payload}.${sign(`${header}.${payload}`)}`;
    return {access_token: token, id_token: token, expires_in: 28800, workspaceId: repository.workspace.id};
  };
  const identity = authorization => {
    const token = typeof authorization === "string" ? authorization.match(/^Bearer ([A-Za-z0-9._-]{1,4096})$/)?.[1] : undefined;
    if (!token) return undefined;
    const [header, payload, signature, extra] = token.split(".");
    const expected = sign(`${header}.${payload}`);
    if (extra || typeof signature !== "string" || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return undefined;
    try {
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
      if (claims.iss !== "teamspaces-local" || claims.sub !== program.owner.id || claims.workspaceId !== repository.workspace.id || !(claims.exp > Date.now() / 1000)) return undefined;
      return claims;
    } catch { return undefined; }
  };
  return {repository, save, session, identity, ownerKeyFile: keyFile, restored};
}

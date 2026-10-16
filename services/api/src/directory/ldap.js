// @ts-nocheck

import tls from "node:tls";
import {ServiceUnavailableError, UnauthorizedError, ValidationError} from "../errors.js";

function lengthBytes(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  for (let value = length; value > 0; value >>>= 8) bytes.unshift(value & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function element(tag, value = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([Buffer.from([tag]), lengthBytes(body.length), body]);
}

function integer(value, tag = 0x02) {
  if (!Number.isInteger(value) || value < 0) throw new ValidationError("LDAP integer is invalid");
  const bytes = [];
  for (let current = value; current > 0; current >>>= 8) bytes.unshift(current & 0xff);
  if (!bytes.length) bytes.push(0);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return element(tag, Buffer.from(bytes));
}

function octet(value, tag = 0x04) {
  return element(tag, Buffer.from(String(value ?? ""), "utf8"));
}

function sequence(parts, tag = 0x30) {
  return element(tag, Buffer.concat(parts));
}

function boolean(value) {
  return element(0x01, Buffer.from([value ? 0xff : 0]));
}

function readElement(buffer, offset = 0) {
  if (offset + 2 > buffer.length) return undefined;
  const tag = buffer[offset];
  const first = buffer[offset + 1];
  let length;
  let headerLength = 2;
  if ((first & 0x80) === 0) length = first;
  else {
    const count = first & 0x7f;
    if (!count || count > 4 || offset + 2 + count > buffer.length) return undefined;
    length = 0;
    for (let index = 0; index < count; index += 1) length = length * 256 + buffer[offset + 2 + index];
    headerLength += count;
  }
  const contentStart = offset + headerLength;
  const end = contentStart + length;
  if (end > buffer.length) return undefined;
  return {tag, offset, contentStart, end, length, value: buffer.subarray(contentStart, end)};
}

function childElements(value) {
  const children = [];
  let offset = 0;
  while (offset < value.length) {
    const child = readElement(value, offset);
    if (!child) throw new ServiceUnavailableError("LDAP server returned malformed BER data");
    children.push(child);
    offset = child.end;
  }
  return children;
}

function integerValue(value) {
  let result = 0;
  for (const byte of value) result = result * 256 + byte;
  return result;
}

function ldapMessage(messageId, operation) {
  return sequence([integer(messageId), operation]);
}

function bindRequest(messageId, dn, password) {
  return ldapMessage(messageId, sequence([integer(3), octet(dn), octet(password, 0x80)], 0x60));
}

function unbindRequest(messageId) {
  return ldapMessage(messageId, element(0x42));
}

function filterValue(value) {
  const bytes = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\\" && /^[0-9a-f]{2}$/i.test(value.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(value.slice(index + 1, index + 3), 16));
      index += 2;
    } else bytes.push(...Buffer.from(value[index], "utf8"));
  }
  return Buffer.from(bytes);
}

export function encodeLdapFilter(source) {
  const input = String(source ?? "");
  let offset = 0;
  function parse() {
    if (input[offset] !== "(") throw new ValidationError("LDAP filter must start with (");
    offset += 1;
    const operator = input[offset];
    if (["&", "|"].includes(operator)) {
      offset += 1;
      const children = [];
      while (input[offset] === "(") children.push(parse());
      if (input[offset] !== ")" || !children.length) throw new ValidationError("LDAP filter group is invalid");
      offset += 1;
      return sequence(children, operator === "&" ? 0xa0 : 0xa1);
    }
    if (operator === "!") {
      offset += 1;
      const child = parse();
      if (input[offset] !== ")") throw new ValidationError("LDAP NOT filter is invalid");
      offset += 1;
      return sequence([child], 0xa2);
    }
    const close = input.indexOf(")", offset);
    if (close < 0) throw new ValidationError("LDAP filter is incomplete");
    const expression = input.slice(offset, close);
    const match = expression.match(/^([A-Za-z][A-Za-z0-9.-]{0,127})(>=|<=|~=|=)([\s\S]*)$/);
    if (!match) throw new ValidationError("LDAP comparison filter is invalid");
    const [, attribute, comparison, value] = match;
    if (!/^[A-Za-z][A-Za-z0-9.-]{0,127}$/.test(attribute)) throw new ValidationError("LDAP filter attribute is invalid");
    offset = close + 1;
    if (comparison === "=" && value === "*") return element(0x87, Buffer.from(attribute, "utf8"));
    if (comparison === "=" && value.includes("*")) {
      const parts = value.split("*");
      const substrings = [];
      if (parts[0]) substrings.push(element(0x80, filterValue(parts[0])));
      for (const part of parts.slice(1, -1)) if (part) substrings.push(element(0x81, filterValue(part)));
      if (parts.at(-1)) substrings.push(element(0x82, filterValue(parts.at(-1))));
      if (!substrings.length) throw new ValidationError("LDAP substring filter is invalid");
      return sequence([octet(attribute), sequence(substrings)], 0xa4);
    }
    const tag = comparison === "=" ? 0xa3 : comparison === ">=" ? 0xa5 : comparison === "<=" ? 0xa6 : 0xa8;
    return sequence([octet(attribute), element(0x04, filterValue(value))], tag);
  }
  const encoded = parse();
  if (offset !== input.length) throw new ValidationError("LDAP filter contains trailing data");
  return encoded;
}

export function escapeLdapFilterValue(value) {
  return String(value ?? "").replace(/[\\*()\0]/g, (character) => `\\${character.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function searchRequest(messageId, {baseDn, filter, attributes, sizeLimit = 500, timeLimitSeconds = 8}) {
  return ldapMessage(messageId, sequence([
    octet(baseDn),
    integer(2, 0x0a),
    integer(0, 0x0a),
    integer(sizeLimit),
    integer(timeLimitSeconds),
    boolean(false),
    encodeLdapFilter(filter),
    sequence(attributes.map((attribute) => octet(attribute)))
  ], 0x63));
}

function parsedMessage(frame) {
  const outer = readElement(frame);
  if (!outer || outer.tag !== 0x30 || outer.end !== frame.length) throw new ServiceUnavailableError("LDAP server returned an invalid message");
  const children = childElements(outer.value);
  if (children.length < 2 || children[0].tag !== 0x02) throw new ServiceUnavailableError("LDAP server returned an invalid message envelope");
  return {messageId: integerValue(children[0].value), operation: children[1]};
}

function ldapResult(operation) {
  const children = childElements(operation.value);
  return {code: children[0]?.tag === 0x0a ? integerValue(children[0].value) : -1, matchedDn: children[1]?.value.toString("utf8") ?? "", message: children[2]?.value.toString("utf8") ?? ""};
}

function searchEntry(operation) {
  const children = childElements(operation.value);
  const dn = children[0]?.value.toString("utf8") ?? "";
  const attributes = {};
  for (const attribute of childElements(children[1]?.value ?? Buffer.alloc(0))) {
    const parts = childElements(attribute.value);
    const name = parts[0]?.value.toString("utf8").toLowerCase();
    if (!name) continue;
    attributes[name] = childElements(parts[1]?.value ?? Buffer.alloc(0)).map((value) => value.value.toString("utf8"));
  }
  return {dn, attributes};
}

export class LdapConnection {
  constructor({host, caCertificate, timeoutMs = 10000, socketFactory = tls.connect} = {}) {
    this.host = host;
    this.caCertificate = caCertificate;
    this.timeoutMs = timeoutMs;
    this.socketFactory = socketFactory;
    this.messageId = 0;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
  }

  async connect() {
    const endpoint = new URL(this.host);
    if (endpoint.protocol !== "ldaps:") throw new ValidationError("LDAP host must use ldaps://");
    this.socket = this.socketFactory({host: endpoint.hostname, port: Number(endpoint.port || 636), servername: endpoint.hostname, rejectUnauthorized: true, ...(this.caCertificate ? {ca: this.caCertificate} : {})});
    this.socket.on("data", (chunk) => this.onData(chunk));
    this.socket.on("error", (error) => this.rejectAll(error));
    this.socket.on("close", () => this.rejectAll(new Error("LDAP connection closed")));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("LDAP connection timed out")), this.timeoutMs);
      timer.unref?.();
      this.socket.once("secureConnect", () => { clearTimeout(timer); resolve(undefined); });
      this.socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    }).catch((error) => {
      this.socket?.destroy();
      throw new ServiceUnavailableError(error?.message === "LDAP connection timed out" ? error.message : "Unable to establish the verified LDAPS connection");
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const frame = readElement(this.buffer);
      if (!frame) break;
      const bytes = this.buffer.subarray(0, frame.end);
      this.buffer = this.buffer.subarray(frame.end);
      const message = parsedMessage(bytes);
      this.pending.get(message.messageId)?.onMessage(message.operation);
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(new ServiceUnavailableError("LDAP connection failed"));
    this.pending.clear();
  }

  send(operation, onOperation) {
    const messageId = ++this.messageId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(messageId);
        reject(new ServiceUnavailableError("LDAP operation timed out"));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(messageId, {
        reject,
        onMessage: (response) => {
          try {
            const result = onOperation(response);
            if (result?.done) {
              clearTimeout(timer);
              this.pending.delete(messageId);
              resolve(result.value);
            }
          } catch (error) {
            clearTimeout(timer);
            this.pending.delete(messageId);
            reject(error);
          }
        }
      });
      this.socket.write(operation(messageId));
    });
  }

  bind(dn, password) {
    return this.send((id) => bindRequest(id, dn, password), (operation) => {
      if (operation.tag !== 0x61) return {};
      const result = ldapResult(operation);
      if (result.code !== 0) throw new UnauthorizedError("LDAP credentials were rejected");
      return {done: true, value: true};
    });
  }

  search(options) {
    const entries = [];
    return this.send((id) => searchRequest(id, options), (operation) => {
      if (operation.tag === 0x64) {
        entries.push(searchEntry(operation));
        if (entries.length > Number(options.sizeLimit ?? 500)) throw new ServiceUnavailableError("LDAP search exceeded its configured result limit");
        return {};
      }
      if (operation.tag !== 0x65) return {};
      const result = ldapResult(operation);
      if (result.code === 4) throw new ServiceUnavailableError("LDAP search reached its configured result limit; no partial synchronization was applied");
      if (result.code !== 0) throw new ServiceUnavailableError(`LDAP search failed with result code ${result.code}`);
      return {done: true, value: entries};
    });
  }

  close() {
    if (!this.socket || this.socket.destroyed) return;
    try { this.socket.write(unbindRequest(++this.messageId)); } catch {}
    this.socket.end();
  }
}

function attribute(entry, name) {
  return entry.attributes[String(name ?? "").toLowerCase()] ?? [];
}

function ldapAttributes(configuration) {
  return [...new Set([
    configuration.loginAttribute ?? "uid",
    configuration.emailAttribute ?? "mail",
    configuration.firstNameAttribute ?? "givenName",
    configuration.lastNameAttribute ?? "sn",
    configuration.displayNameAttribute ?? "displayName",
    configuration.statusAttribute,
    configuration.departmentAttribute,
    configuration.memberOfAttribute ?? "memberOf"
  ].filter(Boolean))];
}

function mappedUser(entry, configuration) {
  const email = attribute(entry, configuration.emailAttribute ?? "mail")[0];
  if (!email) return undefined;
  const display = attribute(entry, configuration.displayNameAttribute ?? "displayName")[0];
  const first = attribute(entry, configuration.firstNameAttribute ?? "givenName")[0] ?? "";
  const last = attribute(entry, configuration.lastNameAttribute ?? "sn")[0] ?? "";
  const statusValue = attribute(entry, configuration.statusAttribute)[0];
  return {
    externalId: entry.dn,
    email: email.toLowerCase(),
    name: display || `${first} ${last}`.trim() || email,
    status: configuration.disabledStatusValue && statusValue === configuration.disabledStatusValue ? "disabled" : "active",
    department: attribute(entry, configuration.departmentAttribute)[0],
    groupDns: attribute(entry, configuration.memberOfAttribute ?? "memberOf"),
    login: attribute(entry, configuration.loginAttribute ?? "uid")[0]
  };
}

export class LdapDirectoryRuntime {
  constructor({resolveCredential, connectionFactory = (options) => new LdapConnection(options)} = {}) {
    this.resolveCredential = resolveCredential;
    this.connectionFactory = connectionFactory;
  }

  async credential(configuration) {
    if (!configuration.bindCredentialReference) throw new ServiceUnavailableError("LDAP bindCredentialReference is required");
    const credential = await this.resolveCredential(configuration.bindCredentialReference);
    if (!credential?.bindDn || !credential?.bindPassword) throw new ServiceUnavailableError("LDAP bind credentials are incomplete");
    return credential;
  }

  async serviceConnection(configuration, credential) {
    const connection = this.connectionFactory({host: configuration.host, caCertificate: credential.caCertificate, timeoutMs: Number(configuration.timeoutMs ?? 10000)});
    await connection.connect();
    await connection.bind(credential.bindDn, credential.bindPassword);
    return connection;
  }

  async authenticate(configuration, {username, password}) {
    if (!username || !password) throw new UnauthorizedError("LDAP credentials are invalid");
    const credential = await this.credential(configuration);
    const connection = await this.serviceConnection(configuration, credential);
    try {
      const baseFilter = configuration.userFilter || "(objectClass=person)";
      const loginAttribute = configuration.loginAttribute ?? "uid";
      const entries = await connection.search({baseDn: configuration.baseDn, filter: `(&${baseFilter}(${loginAttribute}=${escapeLdapFilterValue(username)}))`, attributes: ldapAttributes(configuration), sizeLimit: 2});
      if (entries.length !== 1) throw new UnauthorizedError("LDAP credentials are invalid");
      await connection.bind(entries[0].dn, password);
      const user = mappedUser(entries[0], configuration);
      if (!user || user.status === "disabled") throw new UnauthorizedError("LDAP credentials are invalid");
      return user;
    } finally {
      connection.close();
    }
  }

  async synchronize(configuration) {
    const credential = await this.credential(configuration);
    const connection = await this.serviceConnection(configuration, credential);
    try {
      const users = (await connection.search({baseDn: configuration.baseDn, filter: configuration.userFilter || "(objectClass=person)", attributes: ldapAttributes(configuration), sizeLimit: Number(configuration.sizeLimit ?? 500)})).map((entry) => mappedUser(entry, configuration)).filter(Boolean);
      let groups = [];
      if (configuration.syncGroups && configuration.groupBaseDn) {
        const groupNameAttribute = configuration.groupNameAttribute ?? "cn";
        const groupMemberAttribute = configuration.groupMemberAttribute ?? "member";
        const entries = await connection.search({baseDn: configuration.groupBaseDn, filter: configuration.groupFilter || "(objectClass=groupOfNames)", attributes: [groupNameAttribute, groupMemberAttribute], sizeLimit: Number(configuration.groupSizeLimit ?? 500)});
        groups = entries.map((entry) => ({externalId: entry.dn, name: attribute(entry, groupNameAttribute)[0] ?? entry.dn, memberDns: attribute(entry, groupMemberAttribute)}));
      }
      return {users, groups};
    } finally {
      connection.close();
    }
  }
}

export function createLdapDirectoryRuntime(options) {
  return new LdapDirectoryRuntime(options);
}

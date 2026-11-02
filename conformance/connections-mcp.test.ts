// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSignedAgentCard, generateKeyPair, signPayload } from '../packages/core/src/index.js';
import { AcpMcpServer } from '../packages/runtime/src/index.js';
import { InMemoryRelay } from '../packages/relay/src/index.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root,{ recursive:true,force:true }); });
async function call(server: AcpMcpServer,name: string,args: object = {}) {
  return server.handle({ jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args} }) as Promise<any>;
}
it.each(['open','all','invite-only',null,undefined])('rejects removed MCP accessMode (%s) as -32602', async accessMode => {
  const server = new AcpMcpServer({ relay:new InMemoryRelay() });
  expect((await call(server,'acp_discover_workers',{accessMode})).error.code).toBe(-32602);
});
it('lists all current verified cards and retains original historical signatures without mode projections', async () => {
  const relay = new InMemoryRelay(), endpoint = 'https://relay.example';
  const cards = [undefined,'open','invite-only'].map(mode => {
    const owner = generateKeyPair(), current = createSignedAgentCard({name:'Peer',agentDid:owner.did,relayEndpoint:endpoint,skills:[],protocolVersions:['0.2.0','0.1.0']},owner);
    return mode ? signPayload({...current.payload,accessMode:mode,openPolicy:{retired:-1}},owner) : current;
  }); cards.forEach(card => relay.register(card));
  const result = (await call(new AcpMcpServer({relay}),'acp_discover_workers')).result.structuredContent;
  expect(result.count).toBe(3);
  for (const row of result.workers) { expect(row).not.toHaveProperty('accessMode');expect(row).not.toHaveProperty('openPolicy');
    expect(row.signedAgentCard).toEqual(cards.find(c => c.payload.ownerDid === row.ownerDid)); }
});
it('connection listing is read-only and exposes no decision tool', async () => {
  const root = mkdtempSync(join(tmpdir(),'connections-mcp-'));roots.push(root);
  const server = new AcpMcpServer({identityOptions:{env:{SEALBRIDGE_DATA_DIR:root}}});
  for (const name of ['acp_list_connections','acp_list_connection_requests']) {
    expect((await call(server,name)).result.structuredContent).toEqual({count:0,connections:[]});
    expect((await call(server,name,{to:'peer'})).error.code).toBe(-32602);
  }
  expect(existsSync(join(root,'identities'))).toBe(false);
  expect((await call(server,'acp_approve_connection')).error.code).toBe(-32602);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { inventory,inventoryBlockers,sha } from '../src/account-deletion/owners/preflight.js';
import { deletionMetadataRelations } from '../src/account-deletion/owner-registry.js';
import type { PoolClient } from 'pg';
import type { InventoryRow } from '../src/account-deletion/owners/preflight.js';
import { validateNativeBaseline } from '../src/account-deletion/owners/baseline.js';
const row:InventoryRow={relation:'whaleu_messaging.messages',shape_hash:'a',rows_hash:'empty',row_count:0,supported:false};
test('unsupported indirect/JSON/raw data cannot be called no-data merely without account FK',()=>{assert.deepEqual(inventoryBlockers([row],[row]),[]);for(const rows_hash of ['actor-reference-without-fk','nested-json-snapshot','opaque-provider-subject','raw-import-bytes'])assert.ok(inventoryBlockers([row],[{...row,rows_hash,row_count:1}]).some(x=>x.startsWith('UNSUPPORTED_OWNER_DATA:')));});
test('unknown, disappeared and shape-changed owners block',()=>{assert.ok(inventoryBlockers([row],[]).includes('OWNER_INVENTORY_CHANGED'));assert.ok(inventoryBlockers([row],[row,{...row,relation:'whaleu_unknown.payload'}]).includes('OWNER_INVENTORY_CHANGED'));assert.ok(inventoryBlockers([row],[{...row,shape_hash:'changed'}]).includes('OWNER_SHAPE_CHANGED'));});
test('supported designation cannot silently expand between observations',()=>assert.ok(inventoryBlockers([row],[{...row,supported:true}]).includes('OWNER_SHAPE_CHANGED')));
test('canonical seals are stable through PostgreSQL JSON object key ordering',()=>assert.equal(sha({b:2,a:[{z:3,b:1}]}),sha({a:[{b:1,z:3}],b:2})));
test('missing or arbitrary native baseline cannot be retained as complete',()=>{assert.throws(()=>validateNativeBaseline({},'account'));assert.throws(()=>validateNativeBaseline({'whaleu_experience.owners':[{owner_id:'account',private_payload:'secret'}]},'account'));});
test('unreviewed foreign/materialized storage and extra coordinator relations fail from catalog metadata without reading payloads',async()=>{
 for(const bad of [{relation:'whaleu_profile.external_payload',kind:'f'},{relation:'whaleu_profile.cached_private_payload',kind:'m'},{relation:'whaleu_account_deletion.unreviewed_payload',kind:'r'},{relation:'whaleu_meta.unreviewed_payload',kind:'r'}]){
  let calls=0;
  const tx={query:async(sql:string)=>{calls++;if(calls===1){assert.match(sql,/pg_namespace/);return {rows:[{name:'whaleu_profile'},{name:'whaleu_account_deletion'},{name:'whaleu_meta'}]};}if(calls===2){assert.match(sql,/pg_class/);return {rows:[...[...deletionMetadataRelations].map(relation=>({relation,kind:'r'})),bad]};}assert.fail('Must not read unreviewed data or contact foreign servers');}} as unknown as PoolClient;
  await assert.rejects(inventory(tx),/UNSUPPORTED_OWNER_RELATION_KIND|COORDINATOR_INVENTORY_CHANGED/);assert.equal(calls,2);
 }
});

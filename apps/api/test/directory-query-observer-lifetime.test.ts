import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { DatabaseService } from '../src/database/database.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
  transactionReadEpoch,
} from '../src/database/transaction-deadlines.js';
import { observeDirectoryQueries } from './support/directory-query-observer.js';

test('directory query observation retains one transaction identity through proof restoration and changes it on client reuse', async () => {
  const tx = { query: async () => ({ rows: [] }) } as unknown as PoolClient;
  const database = {
    transaction: async <T>(operation: (client: PoolClient) => Promise<T>) => {
      startTransactionDeadlines(tx);
      try {
        return await operation(tx);
      } finally {
        clearTransactionDeadlines(tx);
      }
    },
  } as DatabaseService;
  const app = { get: () => database } as unknown as INestApplication;
  const observer = observeDirectoryQueries(app);
  const ids: symbol[] = [];
  observer.setHook(async ({ transactionId }, client) => {
    assert.equal(client, tx);
    ids.push(transactionId);
  });
  try {
    await database.transaction(async (client) => {
      const checkpoint = checkpointTransactionDeadlines(client),
        epoch = transactionReadEpoch(client);
      await client.query('SELECT 1');
      restoreTransactionDeadlines(client, checkpoint);
      assert.notEqual(transactionReadEpoch(client), epoch);
      await client.query('SELECT 2');
    });
    await database.transaction(async (client) => {
      await client.query('SELECT 3');
    });
    assert.equal(ids.length, 3);
    assert.equal(ids[0], ids[1]);
    assert.notEqual(ids[1], ids[2]);
  } finally {
    observer.restore();
  }
});

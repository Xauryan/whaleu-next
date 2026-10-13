import { createHash } from 'node:crypto';
import { canonicalJson } from '../../community/content-review/contracts.js';
import type { SchoolAdminManagementCommand } from './contracts.js';
export const schoolAdminManagementIntentHash = (
  actor: string,
  command: SchoolAdminManagementCommand,
): string =>
  createHash('sha256')
    .update(
      'whaleu:school-admin-management-command:v1\n' +
        canonicalJson({ actor, command }),
    )
    .digest('hex');

import type { ApiClient } from '../api/client';
import type { Cancellation, Json } from '../platform/contracts';
import {
  decodeStudentApplication,
  decodeStudentOwn,
  decodeStudentReceipt,
  decodeStudentRecovery,
  decodeStudentQueue,
  decodeStudentCapabilities,
  decodeStudentNotices,
  decodeStudentNoticeTarget,
  studentUuid,
  exactStudent,
  invalidStudent,
} from './student-contract';
import type { VerificationEvidenceUploadDescriptor } from './evidence-contract';
const own = '/v1/me/student-verification',
  review = '/v1/student-verification-review';
export class HttpStudentVerificationGateway {
  constructor(readonly api: ApiClient) {}
  private call<T>(
    path: string,
    method: 'GET' | 'POST',
    decode: (value: unknown) => T,
    cancel: Cancellation,
    body?: Json,
    query?: Record<string, string | number>,
  ) {
    return this.api.request(
      {
        path,
        method,
        authentication: 'required',
        authReplay: method === 'GET' ? 'once' : 'never',
        successStatus: 200,
        decode,
      },
      {
        cancellation: cancel,
        ...(body ? { body } : {}),
        ...(query ? { query } : {}),
      },
    );
  }
  own(c: Cancellation) {
    return this.call(own, 'GET', decodeStudentOwn, c);
  }
  detail(id: string, c: Cancellation, region: string | null = null) {
    return this.call(
      region
        ? `${review}/regions/${studentUuid(region)}/applications/${studentUuid(id)}`
        : `${own}/applications/${studentUuid(id)}`,
      'GET',
      decodeStudentApplication,
      c,
    );
  }
  reserve(
    input: { clientRequestId: string; campusId: string },
    c: Cancellation,
  ) {
    return this.call(`${own}/applications`, 'POST', decodeStudentReceipt, c, {
      ...input,
    });
  }
  submit(
    id: string,
    input: {
      clientRequestId: string;
      expectedRevision: number;
      evidence: VerificationEvidenceUploadDescriptor;
    },
    c: Cancellation,
  ) {
    return this.call(
      `${own}/applications/${studentUuid(id)}/submit`,
      'POST',
      decodeStudentReceipt,
      c,
      { ...input, evidence: { ...input.evidence } },
    );
  }
  withdraw(
    id: string,
    input: { clientRequestId: string; expectedRevision: number },
    c: Cancellation,
  ) {
    return this.call(
      `${own}/applications/${studentUuid(id)}/withdraw`,
      'POST',
      decodeStudentReceipt,
      c,
      { ...input },
    );
  }
  decide(
    region: string,
    id: string,
    input:
      | {
          clientRequestId: string;
          expectedRevision: number;
          decision: 'approved';
        }
      | {
          clientRequestId: string;
          expectedRevision: number;
          decision: 'rejected';
          reason: string;
        },
    c: Cancellation,
  ) {
    return this.call(
      `${review}/regions/${studentUuid(region)}/applications/${studentUuid(id)}/decision`,
      'POST',
      decodeStudentReceipt,
      c,
      { ...input },
    );
  }
  recover(key: string, c: Cancellation) {
    return this.call(
      `${own}/requests/${studentUuid(key)}`,
      'GET',
      decodeStudentRecovery,
      c,
    );
  }
  cancelRequest(key: string, hash: string, c: Cancellation) {
    return this.call(
      `${own}/requests/${studentUuid(key)}/cancel`,
      'POST',
      decodeStudentRecovery,
      c,
      { requestHash: hash },
    );
  }
  capabilities(c: Cancellation) {
    return this.call(
      `${review}/capabilities`,
      'GET',
      decodeStudentCapabilities,
      c,
    );
  }
  queue(
    region: string,
    page: number,
    c: Cancellation,
    cursor: string | null = null,
  ) {
    return this.call(
      `${review}/regions/${studentUuid(region)}/applications`,
      'GET',
      decodeStudentQueue,
      c,
      undefined,
      { page, ...(cursor ? { cursor: studentUuid(cursor) } : {}) },
    );
  }
  notices(page: number, c: Cancellation) {
    return this.call(
      `${own}/notices`,
      'GET',
      decodeStudentNotices,
      c,
      undefined,
      { page },
    );
  }
  noticeTarget(id: string, c: Cancellation) {
    return this.call(
      `${own}/notices/${studentUuid(id)}/target`,
      'GET',
      decodeStudentNoticeTarget,
      c,
    );
  }
  noticeRead(id: string, c: Cancellation) {
    return this.call(
      `${own}/notices/${studentUuid(id)}/read`,
      'POST',
      decodeStudentNoticeTarget,
      c,
      {},
    );
  }
  regions(campusId: string, c: Cancellation) {
    return this.call(
      '/v1/operating-regions',
      'GET',
      (raw) => {
        exactStudent(raw, ['items']);
        if (!Array.isArray(raw.items) || raw.items.length > 1) invalidStudent();
        return raw.items.map((r) => {
          exactStudent(r, ['id', 'name', 'isActive']);
          if (typeof r.name !== 'string' || r.isActive !== true)
            invalidStudent();
          return { id: studentUuid(r.id), name: r.name };
        });
      },
      c,
      undefined,
      { campusId: studentUuid(campusId) },
    );
  }
}

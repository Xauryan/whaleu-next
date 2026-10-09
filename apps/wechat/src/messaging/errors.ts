import { clientError } from '../api/errors';
import { communityError, reasonMessage } from '../community/controller';
export const reason = (code: string): string =>
  ({
    DM_COMMAND_CANCELLED: '原请求已安全取消；迟到的同编号请求不会再执行',
    DM_NOT_FOUND: '此私信会话当前不可查看',
    DM_UNAVAILABLE: '私信服务或历史范围尚不能确认，请稍后重试',
    DM_ENTRY_UNAVAILABLE: '原内容或所选私信身份当前不可用',
    DM_SEND_UNAVAILABLE: '此会话当前不能继续发送',
    DM_FIRST_CONTACT_LIMIT: '对方回复前仅可发送一条消息，撤回或隐藏不会重置',
    DM_RATE_LIMITED: '私信操作过于频繁，请稍后重试',
    DM_RECALL_EXPIRED: '消息已超过 120 秒撤回期限',
    DM_CURSOR_STALE: '会话列表已更新，请刷新后重新翻页',
    DM_OBSERVATION_UNAVAILABLE: '阅读凭据已失效，请重新加载消息',
    CONTENT_REJECTED: '内容未通过审核，可修改后发起新请求',
    CONTENT_REVIEW_UNAVAILABLE: '暂不能确认此文字的有效审核，尚未发送',
    REQUEST_NOT_FOUND: '暂未找到原回执；原请求仍可能完成',
    REQUEST_CONFLICT: '原请求与内容不一致，已停止重发',
  })[code] ?? reasonMessage(code);
export function messagingError(error: unknown): string {
  const e = clientError(error);
  if (
    e.details.serverCode?.startsWith('DM_') ||
    [
      'REQUEST_NOT_FOUND',
      'REQUEST_CONFLICT',
      'CONTENT_REJECTED',
      'CONTENT_REVIEW_UNAVAILABLE',
    ].includes(e.details.serverCode ?? '')
  )
    return reason(e.details.serverCode!);
  if (e.kind === 'business' && !e.details.serverCode) return e.message;
  return communityError(e);
}

import { clientError } from '../api/errors';
import { communityError } from '../community/controller';

export function windowDiscussionError(error: unknown): string {
  const f = clientError(error);
  if (f.kind === 'protocol') return communityError(f);
  return (
    (
      {
        PHONE_VERIFICATION_REQUIRED:
          '请先验证手机号；原操作回执和自己的点赞仍可独立查询',
        WINDOW_CATALOG_UNAVAILABLE: '窗口来源暂不能确认；原操作仍可独立恢复',
        WINDOW_NOT_FOUND: '窗口当前不可查看；原操作仍可独立恢复',
        WINDOW_DISCUSSION_NOT_FOUND: '这条回复当前不可查看，请重新加载',
        WINDOW_DISCUSSION_BUDGET_UNAVAILABLE:
          '完整讨论当前无法核验，暂不展示不完整的内容或数量；这不代表没有回复',
        WINDOW_DISCUSSION_NOTICE_NOT_FOUND:
          '此通知不存在或不属于当前账号，请重新核验通知列表',
        DISCOVERY_RESTART_REQUIRED:
          '讨论或通知已变化，请从第一页重新核验；旧分页已清除',
        WINDOW_DISCUSSION_HISTORY_UNAVAILABLE:
          '回复或点赞历史暂不能确认，不能当作没有回复或零个赞',
        WINDOW_DISCUSSION_MEMBERSHIP_CONFLICT:
          '自己的点赞已在别处变化，请重新查询并明确确认',
        WINDOW_REVISION_CONFLICT: '窗口目录已变化，请刷新后重新确认',
        WINDOW_DISCUSSION_CURSOR_INVALID: '分页已失效，请从第一页重新加载',
        WINDOW_DISCUSSION_RESTART_REQUIRED:
          '回复或排序已变化，请从第一页重新加载',
        WINDOW_DISCUSSION_TARGET_UNAVAILABLE:
          '这条通知的当前内容不可查看，未打开旧内容',
        REQUEST_NOT_FOUND:
          '暂未查到原回执；重试仍使用原请求，取消必须取得服务端回执',
        CONTENT_REVIEW_UNAVAILABLE:
          '当前内容审核暂不能确认；待确认的原请求仍可查询或明确取消',
        SAFETY_ACTION_RESTRICTED:
          '当前账号暂不能访问公开讨论；原回执和自己的点赞仍可独立查询',
      } as Record<string, string>
    )[f.details.serverCode ?? ''] ?? communityError(error)
  );
}

import { clientError } from '../api/errors';
import { communityError } from '../community/controller';

export function majorDiscussionError(error: unknown): string {
  const f = clientError(error);
  if (f.kind === 'protocol') return communityError(f);
  return (
    (
      {
        MAJOR_BASE_REQUIRED:
          '发表专业回复需要有效正式认证、临时认证或实际管理权限；浏览和点赞不要求同校认证',
        PHONE_VERIFICATION_REQUIRED:
          '请先验证手机号；原操作回执和自己的点赞仍可独立查询',
        MAJOR_CATALOG_UNAVAILABLE: '专业来源暂不能确认；原操作仍可独立恢复',
        MAJOR_NOT_FOUND: '专业当前不可查看；原操作仍可独立恢复',
        MAJOR_DISCUSSION_NOT_FOUND: '这条回复当前不可查看，请重新加载',
        MAJOR_DISCUSSION_BUDGET_UNAVAILABLE:
          '完整讨论当前无法核验，暂不展示不完整的内容或数量；这不代表没有回复',
        MAJOR_DISCUSSION_NOTICE_NOT_FOUND:
          '此通知不存在或不属于当前账号，请重新核验通知列表',
        DISCOVERY_RESTART_REQUIRED:
          '讨论或通知已变化，请从第一页重新核验；旧分页已清除',
        MAJOR_DISCUSSION_HISTORY_UNAVAILABLE:
          '回复或点赞历史暂不能确认，不能当作没有回复或零个赞',
        MAJOR_DISCUSSION_MEMBERSHIP_CONFLICT:
          '自己的点赞已在别处变化，请重新查询并明确确认',
        MAJOR_REVISION_CONFLICT: '专业目录已变化，请刷新后重新确认',
        MAJOR_DISCUSSION_CURSOR_INVALID: '分页已失效，请从第一页重新加载',
        MAJOR_DISCUSSION_RESTART_REQUIRED:
          '回复或排序已变化，请从第一页重新加载',
        MAJOR_DISCUSSION_TARGET_UNAVAILABLE:
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

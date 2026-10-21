import type { SystemNotice } from '../community/system-notices-contract';
export function systemNoticeSummary(notice: SystemNotice): string {
  switch (notice.kind) {
    case 'account_punishment_issued':
    case 'account_punishment_released':
      return '账号状态有更新';
    case 'account_appeal_decided':
      return '申诉处理结果已更新';
    case 'post_jury_removed':
      return '帖子陪审结果已更新';
    case 'profile_nickname_reset':
      return '公开昵称有更新';
    case 'profile_custom_avatar_cleared':
      return '公开头像有更新';
    case 'admin_post_removed':
    case 'admin_discussion_removed':
      return '内容处理结果已更新';
  }
}

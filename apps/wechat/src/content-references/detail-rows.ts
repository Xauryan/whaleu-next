import type { DetailView } from '../pages/community-detail/controller';
import type { ReferenceRow } from './controller';
/** Current displayed DTOs only. No lookup of invisible pages or cursor changes. */
export function detailReferenceRows(view: DetailView): ReferenceRow[] {
  if (view.busy || !view.loaded || view.needsReload || !view.post) return [];
  const post = view.post;
  const rows: ReferenceRow[] = [
    { kind: 'post', targetId: post.id, text: post.text },
  ];
  for (const root of [
    ...view.comments,
    ...(view.locatedComment ? [view.locatedComment] : []),
  ]) {
    rows.push({
      kind: 'comment',
      targetId: root.id,
      text: root.text,
      thread: { postId: post.id, rootCommentId: root.id },
    });
    for (const reply of root.replyPreview.items)
      rows.push({
        kind: 'reply',
        targetId: reply.id,
        text: reply.text,
        thread: { postId: post.id, rootCommentId: root.id, replyId: reply.id },
      });
  }
  return [
    ...new Map(
      rows.map((row) => [`${row.kind}:${row.targetId}`, row]),
    ).values(),
  ];
}

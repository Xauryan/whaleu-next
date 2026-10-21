import { withModerationDetails } from '../admin-post-removal/presentation';
import { moderationPage } from '../../account-moderation/page';
Page(withModerationDetails(moderationPage('punishment-management')));

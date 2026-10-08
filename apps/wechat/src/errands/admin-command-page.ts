import type { ErrandAdminCommandController } from './admin-command-controller';
type Owner = { commands?: ErrandAdminCommandController };
/** Shared native event names for both administrative surfaces; every decision remains controller-owned. */
export const errandAdminCommandHandlers = {
  onAdminReason(this: Owner, event: { detail: { value: string } }) {
    this.commands?.setReason(event.detail.value);
  },
  onAdminTarget(this: Owner, event: { detail: { value: string } }) {
    this.commands?.setTargetProfileId(event.detail.value);
  },
  onAdminDuration(this: Owner, event: { detail: { value: string } }) {
    this.commands?.setDuration(String(event.detail.value));
  },
  onAdminAction(
    this: Owner,
    event: { currentTarget: { dataset: { value?: string } } },
  ) {
    this.commands?.setAction(event.currentTarget.dataset.value ?? '');
  },
  onAdminPublisherRestriction(
    this: Owner,
    event: { detail: { value: boolean } },
  ) {
    if (typeof event.detail.value === 'boolean')
      this.commands?.setPublisherRestriction(event.detail.value);
  },
  onAdminConfirm(this: Owner) {
    void this.commands?.confirm();
  },
  onAdminDismiss(this: Owner) {
    this.commands?.dismiss();
  },
  onAdminRecover(this: Owner) {
    void this.commands?.recover();
  },
  onAdminRetry(this: Owner) {
    void this.commands?.recover(true);
  },
  onAdminCancel(this: Owner) {
    this.commands?.cancel();
  },
};

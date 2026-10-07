/** Native bootstrap only. Business pages and backend wiring remain explicitly unimplemented. */
App({
  globalData: {
    implementationStage: 'transport-foundation',
    featureParityVerified: false,
  },
  onLaunch() {
    // No automatic provider login, production requests, legacy storage import or data mutation.
  },
});

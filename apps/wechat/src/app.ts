import { clientConfiguration } from './config';
import { createIdentityRuntime, type IdentityRuntime } from './auth/runtime';
import { systemClock } from './platform/clock';

export interface WhaleuApp {
  identity: IdentityRuntime | undefined;
  globalData: { implementationStage: string; featureParityVerified: boolean };
}
App<WhaleuApp>({
  identity: undefined,
  globalData: {
    implementationStage: 'native-identity-slice',
    featureParityVerified: false,
  },
  onLaunch() {
    this.identity = createIdentityRuntime(clientConfiguration, wx, systemClock);
  },
});

import { ShellNavigator } from '../../shell/navigation';
Component({
  properties: {
    selected: { type: String, value: 'home' },
    spaceId: { type: String, value: '' },
  },
  data: { navigationError: '' },
  navigator: undefined as ShellNavigator | undefined,
  lifetimes: {
    detached(this: { navigator: ShellNavigator | undefined }) {
      this.navigator?.dispose();
      this.navigator = undefined;
    },
  },
  methods: {
    onNavigate(event: { currentTarget: { dataset: { target: string } } }) {
      this.navigator ??= new ShellNavigator(wx);
      this.setData({ navigationError: '' });
      this.navigator.open(
        event.currentTarget.dataset.target,
        this.properties.selected,
        this.properties.spaceId,
        () => this.setData({ navigationError: '暂时无法打开，请重试' }),
      );
    },
  },
});

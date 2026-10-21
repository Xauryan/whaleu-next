import { studentPage } from '../../verification/student-page';
const definition = studentPage('review');
Page({
  ...definition,
  data: { ...(definition.data as object), detailsExpanded: false },
  onToggleDetails() {
    this.setData({ detailsExpanded: !this.data.detailsExpanded });
  },
});

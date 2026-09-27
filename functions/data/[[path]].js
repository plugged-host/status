/* /data/* → the panel's status export. See ../_lib/panel-data.js. */
import { proxyPanelData } from '../_lib/panel-data.js';

export const onRequest = ({ request, params }) => proxyPanelData(request, [].concat(params.path ?? []).join('/'));

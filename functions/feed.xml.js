/* /feed.xml → the panel's RSS export. A _redirects rewrite to /data/feed.xml
   would only look for a static file, never reach the /data Function. */
import { proxyPanelData } from './_lib/panel-data.js';

export const onRequest = ({ request }) => proxyPanelData(request, 'feed.xml');

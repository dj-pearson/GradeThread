/* US-1901: Web push handlers for GradeThread.
 *
 * This file is injected into the Workbox-generated service worker via
 * `importScripts("/push-sw.js")` (see vite.config.ts VitePWA workbox config), so
 * push/notificationclick handlers register WITHOUT hand-editing the generated
 * offline SW. Keep it dependency-free vanilla SW JavaScript.
 */

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_err) {
    // Fall back to plain text if the payload isn't JSON.
    try {
      data = { title: "GradeThread", body: event.data ? event.data.text() : "" };
    } catch (_err2) {
      data = {};
    }
  }

  const title = data.title || "GradeThread";
  const url = data.url || "/dashboard";
  const options = {
    body: data.body || "",
    icon: data.icon || "/logo_icon_192.png",
    badge: data.badge || "/logo_icon_192.png",
    tag: data.tag || undefined,
    data: { url },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/dashboard";
  const targetPath = new URL(targetUrl, self.location.origin).pathname;

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((wins) => {
        // Focus an existing tab already on the target path, if any.
        const existing = wins.find((w) => {
          try {
            return new URL(w.url).pathname === targetPath;
          } catch (_err) {
            return false;
          }
        });
        if (existing) return existing.focus();
        return self.clients.openWindow(targetUrl);
      }),
  );
});

/**
 * dsh-pharos — host half (no-op).
 *
 * Everything this plugin does lives in the browser half (lib/client.js):
 * system notifications, chimes and the tab-title marker when the agent needs
 * your input or a reply finishes in the background. This module exists only so
 * the loader entry mounts the package, letting dsh-client-modules pick up the
 * dsh.client declaration and serve /plugins/dsh-pharos/client.js to the page.
 */

/** Plugin identity for cordis.yml rows. */
export const name = "dsh-pharos";

/**
 * Host loader entry: nothing to mount on the server side.
 * @param ctx - host cordis context.
 */
export function apply() {}
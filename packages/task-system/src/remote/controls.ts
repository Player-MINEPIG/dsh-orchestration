/** Old profiles paused the entire service. Preserve their effective listener until an explicit edit. */
export function remoteListenerEnabled(config: { paused?: unknown; exposeHttp?: unknown; pauseScope?: unknown }): boolean {
  return config.exposeHttp === true && (config.pauseScope === 'executor' || config.paused !== true);
}
export function remoteExecutorPaused(config: { paused?: unknown; coordinator?: unknown }): boolean {
  return config.paused === true || config.coordinator == null;
}
/** Persist alongside the next explicit connection edit, never as an upgrade write. */
export function independentRemoteControls(config: { paused?: unknown; exposeHttp?: unknown; pauseScope?: unknown; coordinator?: unknown }) {
  return { paused: remoteExecutorPaused(config), pauseScope: 'executor' as const, exposeHttp: remoteListenerEnabled(config) };
}

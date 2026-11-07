'use strict';

const { LaunchError } = require('../errors');

/**
 * Contrôle d'une opération longue : Annuler et Pause.
 *   const c = createControl();
 *   install(plan, { control: c });  c.pause(); c.resume(); c.cancel();
 * Un contrôle « enfant » suit la pause et l'annulation de son parent, mais peut
 * être annulé seul (une erreur interne n'annule jamais le contrôle de l'appelant).
 */
function createControl(parent = null) {
  const ac = new AbortController();
  let paused = false;
  let pauseEpoch = 0;
  let waiters = [];
  const wake = () => { const w = waiters; waiters = []; for (const fn of w) fn(); };
  const control = {
    signal: ac.signal,
    get paused() { return paused || (parent ? parent.paused : false); },
    get cancelled() { return ac.signal.aborted; },
    /** Augmente à chaque pause (sert à ne pas compter une pause comme un échec). */
    get pauseEpoch() { return pauseEpoch + (parent ? parent.pauseEpoch : 0); },
    pause() { if (!paused) { paused = true; pauseEpoch++; } },
    resume() { paused = false; wake(); },
    cancel() { if (!ac.signal.aborted) ac.abort(); wake(); },
    /** Attend tant que c'est en pause ; lève CANCELLED si annulé. */
    async wait() {
      for (;;) {
        if (ac.signal.aborted) throw new LaunchError('CANCELLED');
        if (parent) {
          // Attente du parent, interrompue si CE contrôle est annulé (ex. erreur pendant une pause).
          await new Promise((resolve, reject) => {
            const onAbort = () => reject(new LaunchError('CANCELLED'));
            ac.signal.addEventListener('abort', onAbort, { once: true });
            Promise.resolve(parent.wait()).then(resolve, reject).finally(() => ac.signal.removeEventListener('abort', onAbort));
          });
        }
        if (ac.signal.aborted) throw new LaunchError('CANCELLED');
        if (!paused) return;
        await new Promise((resolve) => waiters.push(resolve));
      }
    },
    /** Libère les écouteurs posés sur le parent. */
    dispose() { if (parent && parent.signal) parent.signal.removeEventListener('abort', onParentAbort); },
  };
  const onParentAbort = () => control.cancel();
  if (parent && parent.signal) {
    if (parent.signal.aborted) control.cancel();
    else parent.signal.addEventListener('abort', onParentAbort, { once: true });
  }
  // Un parent qui reprend doit réveiller les enfants qui attendent.
  return control;
}

/** Contrôle à partir des options (control fourni, ou simple AbortSignal). */
function normalizeControl(opts = {}) {
  if (opts.control) return opts.control;
  const s = opts.signal;
  if (!s) return createControl();
  return createControl({ signal: s, paused: false, pauseEpoch: 0, wait: async () => {} });
}

module.exports = { createControl, normalizeControl };

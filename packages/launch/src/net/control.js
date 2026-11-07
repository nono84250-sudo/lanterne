'use strict';

const { LaunchError } = require('../errors');

/**
 * Contrôle d'une opération longue : Annuler et Pause.
 *   const c = createControl();
 *   install(plan, { control: c });  c.pause(); c.resume(); c.cancel();
 */
function createControl() {
  const ac = new AbortController();
  let paused = false;
  let waiters = [];
  const control = {
    signal: ac.signal,
    get paused() { return paused; },
    get cancelled() { return ac.signal.aborted; },
    pause() { paused = true; },
    resume() {
      paused = false;
      const w = waiters; waiters = [];
      for (const fn of w) fn();
    },
    cancel() {
      ac.abort();
      control.resume();
    },
    /** Attend tant que c'est en pause ; lève CANCELLED si annulé. */
    async wait() {
      if (ac.signal.aborted) throw new LaunchError('CANCELLED');
      while (paused) {
        await new Promise((resolve) => waiters.push(resolve));
        if (ac.signal.aborted) throw new LaunchError('CANCELLED');
      }
    },
  };
  return control;
}

/** Contrôle neutre (ni pause ni annulation) à partir d'un éventuel signal. */
function normalizeControl(opts = {}) {
  if (opts.control) return opts.control;
  const c = createControl();
  const s = opts.signal;
  if (s) {
    if (s.aborted) c.cancel();
    else s.addEventListener('abort', () => c.cancel(), { once: true });
  }
  return c;
}

module.exports = { createControl, normalizeControl };

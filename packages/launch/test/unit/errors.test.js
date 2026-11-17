'use strict';

const test = require('node:test');
const assert = require('node:assert');
const lib = require('../../src');
const { LaunchError, wrap, toLaunchError } = require('../../src/errors');

test('chaque code a un message en français et en anglais, mêmes codes', () => {
  const fr = Object.keys(lib.ERROR_MESSAGES).sort();
  const en = Object.keys(lib.ERROR_MESSAGES_EN).sort();
  assert.deepStrictEqual(en, fr);
  assert.deepStrictEqual(lib.LANGUAGES, ['fr', 'en']);
  for (const code of fr) {
    assert.ok(lib.ERROR_MESSAGES_EN[code].length > 5, code);
    assert.notStrictEqual(lib.ERROR_MESSAGES_EN[code], lib.ERROR_MESSAGES[code], code);
    // L'anglais ne garde pas d'accents ni d'espace insécable avant « : ».
    assert.ok(!/[éèêàçùô]| :/.test(lib.ERROR_MESSAGES_EN[code]), code);
  }
  assert.strictEqual(lib.ERROR_MESSAGES_BY_LANG.fr, lib.ERROR_MESSAGES);
  assert.strictEqual(lib.ERROR_MESSAGES_BY_LANG.en, lib.ERROR_MESSAGES_EN);
});

test('français par défaut (comme avant), anglais avec lang', () => {
  const e = new LaunchError('JAVA_MISSING', 'java.exe');
  assert.strictEqual(e.code, 'JAVA_MISSING');
  assert.strictEqual(e.lang, 'fr');
  assert.strictEqual(e.userMessage, lib.ERROR_MESSAGES.JAVA_MISSING);
  assert.strictEqual(e.message, `${lib.ERROR_MESSAGES.JAVA_MISSING} (java.exe)`);
  const en = new LaunchError('JAVA_MISSING', 'java.exe', { lang: 'en' });
  assert.strictEqual(en.code, 'JAVA_MISSING');
  assert.strictEqual(en.userMessage, 'Java was not found. Install Java or enable automatic Java.');
  assert.strictEqual(en.message, 'Java was not found. Install Java or enable automatic Java. (java.exe)');
  assert.deepStrictEqual(en.userMessages, { fr: lib.ERROR_MESSAGES.JAVA_MISSING, en: lib.ERROR_MESSAGES_EN.JAVA_MISSING });
  assert.ok(en instanceof Error && en instanceof LaunchError);
});

test('setLanguage sur une erreur, variantes de langue, code inconnu', () => {
  const e = new LaunchError('DISK_FULL').setLanguage('EN-us');
  assert.strictEqual(e.userMessage, 'The disk is full.');
  assert.strictEqual(e.message, 'The disk is full.');
  e.setLanguage('fr_FR');
  assert.strictEqual(e.userMessage, 'Plus de place sur le disque.');
  assert.strictEqual(new LaunchError('PAS_UN_CODE', undefined, { lang: 'en' }).userMessage, 'Unknown error.');
  assert.strictEqual(new LaunchError('PAS_UN_CODE').userMessage, 'Erreur inconnue.');
  // Un nom de propriété d'objet n'est pas un code.
  assert.strictEqual(new LaunchError('toString', undefined, { lang: 'en' }).userMessage, 'Unknown error.');
  assert.strictEqual(lib.userMessageFor('OFFLINE', 'en'), lib.ERROR_MESSAGES_EN.OFFLINE);
});

test('setLanguage global : langue par défaut, refuse une langue inconnue', () => {
  try {
    assert.strictEqual(lib.setLanguage('en'), 'en');
    assert.strictEqual(lib.getLanguage(), 'en');
    assert.strictEqual(new LaunchError('NETWORK').userMessage, lib.ERROR_MESSAGES_EN.NETWORK);
    assert.throws(() => lib.setLanguage('de'), (e) => e.code === 'INVALID_OPTION');
    assert.throws(() => lib.setLanguage(42), (e) => e.code === 'INVALID_OPTION');
    assert.strictEqual(lib.getLanguage(), 'en');
    assert.strictEqual(lib.setLanguage(null), 'fr');
    assert.strictEqual(lib.setLanguage('en'), 'en');
    assert.strictEqual(lib.setLanguage(''), 'fr');
  } finally {
    lib.setLanguage('fr');
  }
  assert.strictEqual(new LaunchError('NETWORK').userMessage, lib.ERROR_MESSAGES.NETWORK);
});

test('option lang sur les fonctions publiques : même code, message traduit', async () => {
  await assert.rejects(lib.prepare({ lang: 'en' }), (e) => e.code === 'INVALID_OPTION' && e.userMessage === 'Invalid option.' && e.message.startsWith('Invalid option. ('));
  await assert.rejects(lib.prepare({}), (e) => e.code === 'INVALID_OPTION' && e.userMessage === 'Option invalide.');
  await assert.rejects(lib.prepare({ version: '1.21.4', root: '.', lang: 'klingon' }), (e) => e.code === 'INVALID_OPTION' && /lang/.test(e.message));
  // Erreur système ou inattendue : traduite aussi.
  const boom = wrap(async () => { const e = new Error('x'); e.code = 'ENOSPC'; throw e; });
  await assert.rejects(boom({ lang: 'en' }), (e) => e.code === 'DISK_FULL' && e.userMessage === 'The disk is full.');
  const bug = wrap(async () => { throw new TypeError('oups'); });
  await assert.rejects(bug({ lang: 'en' }), (e) => e.code === 'INTERNAL' && e.userMessage === 'Unexpected engine error.');
  // Les dernières options gagnent sur la langue du plan ; le plan sert sinon.
  const fail = wrap(async () => { throw new LaunchError('NOT_INSTALLED'); });
  await assert.rejects(fail({ files: [], lang: 'en' }, { lang: 'fr' }), (e) => e.userMessage === lib.ERROR_MESSAGES.NOT_INSTALLED);
  await assert.rejects(fail({ files: [], lang: 'en' }), (e) => e.userMessage === lib.ERROR_MESSAGES_EN.NOT_INSTALLED);
  await assert.rejects(fail({ plan: { lang: 'en' } }), (e) => e.userMessage === lib.ERROR_MESSAGES_EN.NOT_INSTALLED);
  // install(plan, { lang }) : l'option l'emporte sur la langue du plan, via l'API publique.
  await assert.rejects(lib.install({ files: [], missing: [], lang: 'fr' }, { lang: 'en', control: 'pas un contrôle' }).then(() => { throw new LaunchError('INTERNAL'); }), (e) => e.lang === 'en');
  // Sans lang : rien ne change.
  await assert.rejects(fail({}), (e) => e.userMessage === lib.ERROR_MESSAGES.NOT_INSTALLED);
});

test('toLaunchError garde le code, le détail et la cause', () => {
  const cause = Object.assign(new Error('no space'), { code: 'ENOSPC' });
  const e = toLaunchError(cause).setLanguage('en');
  assert.strictEqual(e.code, 'DISK_FULL');
  assert.strictEqual(e.cause, cause);
});

test('lang vide ou null = langue par défaut ; langue inconnue refusée partout', async () => {
  const fail = wrap(async () => { throw new LaunchError('NOT_INSTALLED'); });
  await assert.rejects(fail({ lang: null }), (e) => e.userMessage === lib.ERROR_MESSAGES.NOT_INSTALLED);
  await assert.rejects(fail({ lang: '' }), (e) => e.userMessage === lib.ERROR_MESSAGES.NOT_INSTALLED);
  await assert.rejects(fail({ plan: { lang: null } }, {}), (e) => e.userMessage === lib.ERROR_MESSAGES.NOT_INSTALLED);
  const e = new LaunchError('OFFLINE');
  assert.throws(() => e.setLanguage('de'), (x) => x.code === 'INVALID_OPTION');
  assert.strictEqual(e.setLanguage(null).userMessage, lib.ERROR_MESSAGES.OFFLINE);
});

test('la pile (stack) suit la langue du message', () => {
  const e = new LaunchError('DISK_FULL', 'x').setLanguage('en');
  assert.ok(e.stack.startsWith('LaunchError: The disk is full. (x)'), e.stack.split('\n')[0]);
  assert.ok(e.stack.includes('errors.test.js'));
});

test('raccourcis verify(version, { lang }) et repair : message en anglais', async () => {
  await assert.rejects(lib.verify('1.21.4', { lang: 'en' }), (e) => e.code === 'INVALID_OPTION' && e.userMessage === 'Invalid option.');
  await assert.rejects(lib.repair('1.21.4', { lang: 'en' }), (e) => e.code === 'INVALID_OPTION' && e.userMessage === 'Invalid option.');
  await assert.rejects(lib.verify({ version: '1.21.4', lang: 'en' }), (e) => e.userMessage === 'Invalid option.');
  await assert.rejects(lib.launch({ version: '1.21.4', lang: 'en' }), (e) => e.userMessage === 'Invalid option.');
});

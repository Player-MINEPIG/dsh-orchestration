import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function bridge() {
  const source = readFileSync(new URL('../dist/console-client.js', import.meta.url), 'utf8');
  let scheme = 'light', systemDark = false, mutation, mediaListener, disconnected = false;
  const messages = [], frame = { current: { contentWindow: { postMessage: value => messages.push(value) } } };
  const media = { get matches() { return systemDark; }, addEventListener: (_, f) => mediaListener = f, removeEventListener: (_, f) => { assert.equal(f, mediaListener); mediaListener = null; } };
  const context = vm.createContext({ document: { documentElement: {}, body: {} }, getComputedStyle: () => ({ colorScheme: scheme }), matchMedia: () => media, MutationObserver: class { constructor(f) { mutation = f; } observe() {} disconnect() { disconnected = true; } }, frame });
  vm.runInContext(source.slice(source.indexOf('    function hostTheme()'), source.indexOf('    function Page(')), context);
  const cleanup = vm.runInContext('watchTheme(frame, "dsh-decision-settings")', context);
  return { messages, change(s, dark) { scheme = s; systemDark = dark; mutation(); }, system(s, dark) { scheme = s; systemDark = dark; mediaListener(); }, cleanup, stopped: () => disconnected && mediaListener === null };
}
test('host appearance overrides system preference and updates an existing frame without reloading it', () => {
  const b = bridge();
  assert.equal(b.messages.at(-1).input, 'light');
  b.change('dark', false); assert.equal(b.messages.at(-1).input, 'dark');
  b.change('light', true); assert.equal(b.messages.at(-1).input, 'light');
  b.system('normal', true); assert.equal(b.messages.at(-1).input, 'dark');
  b.system('normal', false); assert.equal(b.messages.at(-1).input, 'light');
  assert.ok(b.messages.every(m => m.channel === 'dsh-decision-settings' && m.method === 'theme'));
  b.cleanup(); assert.ok(b.stopped());
});
test('iframe accepts only its parent theme and does not consume pending decision responses', () => {
  const html = readFileSync(new URL('../dist/console-page.html', import.meta.url), 'utf8');
  const source = html.slice(html.indexOf('window.addEventListener("message",'), html.indexOf('window.addEventListener("message",') + 1500);
  const listenerSource = source.slice(0, source.indexOf('\n      });') + '\n      });'.length);
  let listener;
  const parent = {}, pending = new Map([[7, {}]]), root = { dataset: {} };
  vm.runInNewContext(listenerSource, { parent, CHANNEL: 'dsh-decision-settings', pending, document: { documentElement: root }, window: { addEventListener: (_, f) => listener = f } });
  listener({ source: {}, data: { channel: 'dsh-decision-settings', method: 'theme', input: 'dark' } }); assert.equal(root.dataset.theme, undefined);
  listener({ source: parent, data: { channel: 'other', method: 'theme', input: 'dark' } }); assert.equal(root.dataset.theme, undefined);
  listener({ source: parent, data: { channel: 'dsh-decision-settings', method: 'theme', input: 'light' } }); assert.equal(root.dataset.theme, 'light');
  listener({ source: parent, data: { channel: 'dsh-decision-settings', method: 'theme', input: 'invalid' } }); assert.equal(root.dataset.theme, 'light');
  assert.equal(pending.size, 1);
});

test('embedded settings height grows for long rules and shrinks when editors collapse', () => {
  const source=readFileSync(new URL('../dist/console-client.js', import.meta.url),'utf8');
  const frame={current:{style:{height:'650px'}}}, ctx=vm.createContext({frame});
  vm.runInContext(source.slice(source.indexOf('    function fitContentFrame('),source.indexOf('    function Page(')),ctx);
  const resize=height=>vm.runInContext('fitContentFrame(frame,'+height+')',ctx);
  resize(13000.4); assert.equal(frame.current.style.height,'13001px');
  resize(1173.35); assert.equal(frame.current.style.height,'1174px');
  resize(300); assert.equal(frame.current.style.height,'500px');
  resize('NaN'); resize('Infinity'); resize(-1); assert.equal(frame.current.style.height,'500px');
});

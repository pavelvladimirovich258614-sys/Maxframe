import test from 'node:test';
import assert from 'node:assert/strict';
import { MaxKeyboard, menuKeyboard } from '../src/max-keyboard.js';

test('builds the MAX inline keyboard attachment', () => {
  const kb = new MaxKeyboard().text('Да', 'r:1').text('Нет', 'r:2');
  const attachment = kb.toAttachment();
  assert.equal(attachment.type, 'inline_keyboard');
  assert.deepEqual(attachment.payload.buttons, [[
    { type: 'callback', text: 'Да', payload: 'r:1' },
    { type: 'callback', text: 'Нет', payload: 'r:2' },
  ]]);
});

test('a new row starts after a filled one, and empty rows are dropped', () => {
  const kb = new MaxKeyboard().text('a', 'x').row().row().text('b', 'y');
  assert.deepEqual(kb.toAttachment().payload.buttons, [
    [{ type: 'callback', text: 'a', payload: 'x' }],
    [{ type: 'callback', text: 'b', payload: 'y' }],
  ]);
});

test('a link button carries the url', () => {
  const kb = new MaxKeyboard().url('Пульт', 'https://example.com');
  assert.deepEqual(kb.toAttachment().payload.buttons[0][0], { type: 'link', text: 'Пульт', url: 'https://example.com' });
});

test('a clipboard button carries the text to copy', () => {
  const kb = new MaxKeyboard().copyText('Копировать', 'черновик ответа');
  assert.deepEqual(kb.toAttachment().payload.buttons[0][0], { type: 'clipboard', text: 'Копировать', payload: 'черновик ответа' });
});

test('the button text and the payload are cut to the limits of the API', () => {
  const kb = new MaxKeyboard().text('x'.repeat(200), 'y'.repeat(2000));
  const button = kb.toAttachment().payload.buttons[0][0];
  assert.equal(button.text.length, 128);
  assert.equal(button.payload.length, 1024);
});

test('an empty keyboard has no attachment', () => {
  assert.equal(new MaxKeyboard().toAttachment(), null);
  assert.equal(new MaxKeyboard().isEmpty, true);
});

test('the menu keyboard holds the main sections', () => {
  const kb = menuKeyboard({ name: 'Мейнфрейм' });
  const buttons = kb.toAttachment().payload.buttons.flat();
  assert.ok(buttons.length >= 4);
  assert.ok(buttons.some((b) => b.text.includes('Мейнфрейм')));
  assert.ok(buttons.every((b) => b.type === 'callback'));
});

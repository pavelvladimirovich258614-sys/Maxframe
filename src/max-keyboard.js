// Keyboards of the MAX bot.
//
// MAX has one kind of keyboard: an inline keyboard that travels with the message
// as an attachment. The old code built grammY keyboards, so this class keeps the
// same fluent calls (text/row/webApp) and renders into the MAX attachment.
//
// Limits from the API: 210 buttons in total, 30 rows, 7 buttons per row
// (3 for link and open_app buttons), button text 1-128 characters, callback
// payload up to 1024 characters.

const BUTTON_TEXT_LIMIT = 128;
const PAYLOAD_LIMIT = 1024;
const MAX_PER_ROW = 7;

export class MaxKeyboard {
  constructor() {
    this.rows = [];
    this.current = [];
  }

  // A button that sends its payload back in a message_callback update.
  text(label, payload) {
    const text = String(label ?? '').slice(0, BUTTON_TEXT_LIMIT);
    const data = String(payload ?? '').slice(0, PAYLOAD_LIMIT);
    if (!text) return this;
    if (this.current.length >= MAX_PER_ROW) this.row();
    this.current.push({ type: 'callback', text, payload: data });
    return this;
  }

  // A button that opens a link.
  url(label, url) {
    const text = String(label ?? '').slice(0, BUTTON_TEXT_LIMIT);
    if (!text || !url) return this;
    if (this.current.length >= MAX_PER_ROW) this.row();
    this.current.push({ type: 'link', text, url: String(url) });
    return this;
  }

  // The dashboard is a mini app; MAX opens it through a link button.
  webApp(label, url) {
    return this.url(label, url);
  }

  // A button that sends its own text as a message.
  message(label, text) {
    const caption = String(label ?? '').slice(0, BUTTON_TEXT_LIMIT);
    if (!caption) return this;
    if (this.current.length >= MAX_PER_ROW) this.row();
    this.current.push({ type: 'message', text: caption });
    return this;
  }

  // A button that puts the text into the clipboard of the reader.
  copyText(label, text) {
    const caption = String(label ?? '').slice(0, BUTTON_TEXT_LIMIT);
    const payload = String(text ?? '').slice(0, PAYLOAD_LIMIT);
    if (!caption) return this;
    if (this.current.length >= MAX_PER_ROW) this.row();
    this.current.push({ type: 'clipboard', text: caption, payload });
    return this;
  }

  // Start a new row. MAX rejects empty rows, so a row is only kept when it
  // holds at least one button.
  row() {
    if (this.current.length) {
      this.rows.push(this.current);
      this.current = [];
    }
    return this;
  }

  // grammY styling calls: MAX has no colours, they only mark the button.
  primary() { return this; }
  success() { return this; }

  // The rows, in the shape the API expects.
  get inline_keyboard() {
    this.row();
    return this.rows;
  }

  get isEmpty() {
    return this.inline_keyboard.length === 0;
  }

  // The attachment of a message.
  toAttachment() {
    const buttons = this.inline_keyboard;
    if (!buttons.length) return null;
    return { type: 'inline_keyboard', payload: { buttons } };
  }
}

// The keyboard of the main menu: the same buttons, but the menu itself is sent
// as a message with the keyboard attached.
export const menuKeyboard = (project) => {
  const kb = new MaxKeyboard();
  kb.text('📥 Входящие', 'n:inbox').text('📅 Сегодня', 'n:today').text('🧠 Сессии', 'n:sess');
  kb.row().text('📊 Соцсети', 'n:soc').text('⚙️ Ещё', 'n:sys');
  kb.row().text(`🎯 ${project?.name || 'проект'}`, 'n:home');
  return kb;
};

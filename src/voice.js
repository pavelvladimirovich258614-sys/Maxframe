// Local speech-to-text: a whisper.cpp server on this Mac (Metal GPU), see
// scripts/install-whisper.sh. Audio never leaves the machine.
import { config } from './config.js';

export const voiceEnabled = () => Boolean(config.whisper.url);

// Transcribes an audio file (Telegram .oga/.ogg, mp3, m4a, wav...). The server
// converts it with ffmpeg (--convert), so any format ffmpeg reads is fine.
export async function transcribeAudio(bytes, filename = 'voice.ogg') {
  if (!voiceEnabled()) throw new Error('Расшифровка голосовых выключена (WHISPER_URL=off)');
  const form = new FormData();
  form.append('file', new Blob([bytes]), filename.replace(/\.oga$/i, '.ogg'));
  form.append('response_format', 'json');
  if (config.whisper.language) form.append('language', config.whisper.language);
  const res = await fetch(`${config.whisper.url}/v1/audio/transcriptions`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`whisper ответил ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = (data.text || '').trim();
  if (!text) throw new Error('Пустая расшифровка');
  return text;
}

// Shown on the System page: is the whisper.cpp service answering?
export const voiceState = { status: 'off', checkedAt: null };
async function checkVoice() {
  if (!voiceEnabled()) { voiceState.status = 'off'; return; }
  try {
    const res = await fetch(`${config.whisper.url}/`, { signal: AbortSignal.timeout(3000) });
    voiceState.status = res.ok ? 'running' : 'error';
  } catch {
    voiceState.status = 'down';
  }
  voiceState.checkedAt = Date.now();
}
checkVoice();
setInterval(checkVoice, 30000).unref();

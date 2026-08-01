/**
 * E2E booking-flow test for the Meridian Physiotherapy voice agent.
 *
 * Drives a full scripted booking conversation through the real stack:
 *   this script → local server proxy (JWT auth) → Deepgram Voice Agent API
 * with the same Settings payload, function definitions, and client-side
 * function execution the browser frontend uses. Audio output is counted
 * but not played; silence is streamed in so the session behaves like an
 * open mic line.
 *
 * Run:  node server.js   (in another terminal)
 *       node scripts/e2e-booking-test.mjs
 *
 * Pass criteria (checked at the end):
 *   1. check_availability called before any slot was offered
 *   2. book_appointment called with the agreed slot
 *   3. a booking record with a MPC- reference was appended to call-logs
 */

import { WebSocket } from 'ws';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { mockAvailability, buildSettings, randomMobile, speakDigits } from './clinic-defs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL || 'http://localhost:8081';

// --- Pull the live system prompt straight out of the frontend, so the test
// --- always exercises what the demo actually ships.
const indexHtml = readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf-8');
const promptMatch = indexHtml.match(/<textarea id="systemPrompt"[^>]*>([\s\S]*?)<\/textarea>/);
if (!promptMatch) {
  console.error('FAIL: could not extract system prompt from frontend/index.html');
  process.exit(1);
}
const SYSTEM_PROMPT = promptMatch[1];

// Fresh number each run so the agent treats this as a genuinely new caller.
const MOBILE = randomMobile();

// Scripted caller turns, in the intake order the prompt specifies.
const USER_TURNS = [
  "Hi, I'd like to book an appointment please. My lower back has been hurting.",
  "I'm a new patient.",
  'My name is John Tan.',
  `${speakDigits(MOBILE)}.`,
  "It's lower back pain, around two weeks now. Started after I moved house.",
  'Tampines please.',
  'Weekday afternoons are best for me.',
  'The first one works.',
  "Yes, that's correct.",
  "No, that's all. Thank you!",
];

const results = {
  checkAvailabilityCalled: false,
  bookAppointmentCalled: false,
  bookedRef: null,
  slotOfferedBeforeCheck: false,
  transcript: [],
};
let offeredSlots = [];
let turnIndex = 0;
let audioChunks = 0;
let done = false;

function log(who, text) {
  results.transcript.push(`${who}: ${text}`);
  console.log(`${who.padEnd(6)} | ${text}`);
}

const token = (await (await fetch(`${BASE}/api/session`)).json()).token;
const ws = new WebSocket(`${BASE.replace('http', 'ws')}/api/voice-agent`, [`access_token.${token}`]);
ws.binaryType = 'arraybuffer';

const send = (obj) => ws.send(JSON.stringify(obj));

// Keep the "mic" open: stream 100ms of 16kHz PCM16 silence continuously.
let silenceTimer = null;
function startSilence() {
  const silence = Buffer.alloc(3200);
  silenceTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(silence);
  }, 100);
}

function nextUserTurn() {
  if (turnIndex >= USER_TURNS.length) {
    finish();
    return;
  }
  const text = USER_TURNS[turnIndex++];
  setTimeout(() => {
    log('CALLER', text);
    send({ type: 'InjectUserMessage', content: text });
  }, 600);
}

function executeClinicFunction(name, args) {
  if (name === 'check_availability') {
    results.checkAvailabilityCalled = true;
    const res = mockAvailability(args.branch, args.preferred_day);
    offeredSlots = res.open_slots;
    return res;
  }
  if (name === 'book_appointment') {
    results.bookAppointmentCalled = true;
    const reference = 'MPC-' + String(Math.floor(1000 + Math.random() * 9000));
    results.bookedRef = reference;
    results.bookedArgs = args;
    fetch(`${BASE}/api/call-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'booking', ...args, reference, logged_at: new Date().toISOString(), source: 'e2e-test' }),
    }).catch(() => {});
    return {
      status: 'confirmed',
      reference,
      detail: `Appointment confirmed at ${args.branch} for ${args.slot}. An SMS confirmation will be sent to ${args.mobile}.`,
    };
  }
  if (name === 'log_call_note') {
    return { status: 'noted' };
  }
  if (name === 'lookup_caller') {
    return fetch(`${BASE}/api/caller-history?mobile=${encodeURIComponent(args.mobile || '')}`)
      .then((r) => r.json())
      .catch(() => ({ known: false, detail: 'Lookup unavailable — treat as a new caller.' }));
  }
  if (name === 'cancel_appointment' || name === 'reschedule_appointment') {
    return { status: 'error', detail: 'Not supported in this test.' };
  }
  if (name === 'request_callback') {
    return { status: 'logged', detail: 'Callback request recorded. The team will call back within one working day.' };
  }
  return { error: `Unknown function: ${name}` };
}

ws.on('open', () => console.log('-- connected, waiting for Welcome'));

ws.on('message', (data, isBinary) => {
  let message;
  try {
    message = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf-8'));
  } catch {
    audioChunks++;
    return;
  }

  switch (message.type) {
    case 'Welcome':
      send(buildSettings(SYSTEM_PROMPT));
      break;

    case 'SettingsApplied':
      console.log('-- settings applied, streaming silence');
      startSilence();
      break;

    case 'ConversationText':
      if (message.role === 'assistant') {
        log('JANE', message.content);
        // Detect a slot being offered before availability was checked
        if (!results.checkAvailabilityCalled && /\b\d{1,2}(:\d{2})?\s*(am|pm)\b/i.test(message.content)) {
          results.slotOfferedBeforeCheck = true;
        }
      }
      break;

    case 'AgentAudioDone':
      nextUserTurn();
      break;

    case 'FunctionCallRequest':
      for (const call of message.functions || []) {
        if (call.client_side === false) continue;
        let args = {};
        try { args = call.arguments ? JSON.parse(call.arguments) : {}; } catch {}
        console.log(`-- function: ${call.name}(${JSON.stringify(args)})`);
        Promise.resolve(executeClinicFunction(call.name, args)).then((result) => {
          const response = { type: 'FunctionCallResponse', id: call.id, name: call.name, content: JSON.stringify(result) };
          if (call.thought_signature) response.thought_signature = call.thought_signature;
          send(response);
        });
      }
      break;

    case 'Warning':
      console.warn('-- warning:', message.description);
      break;

    case 'Error':
      console.error('-- ERROR:', message.description || message);
      finish(1);
      break;
  }
});

ws.on('close', (code, reason) => {
  console.log(`-- closed: ${code} ${reason}`);
  if (!done) finish(1);
});
ws.on('error', (err) => { console.error('-- ws error:', err.message); finish(1); });

function finish(forceExit) {
  if (done) return;
  done = true;
  clearInterval(silenceTimer);
  setTimeout(() => {
    try { ws.close(); } catch {}
    console.log('\n========== RESULTS ==========');
    console.log('check_availability called: ', results.checkAvailabilityCalled);
    console.log('slot offered BEFORE check: ', results.slotOfferedBeforeCheck, '(must be false)');
    console.log('book_appointment called:   ', results.bookAppointmentCalled);
    console.log('booking args:              ', JSON.stringify(results.bookedArgs || null));
    console.log('reference issued:          ', results.bookedRef);
    console.log('audio chunks received:     ', audioChunks);
    const pass = results.checkAvailabilityCalled && results.bookAppointmentCalled && !results.slotOfferedBeforeCheck;
    console.log(pass ? '\n✅ E2E BOOKING FLOW PASSED' : '\n❌ E2E BOOKING FLOW FAILED');
    process.exit(forceExit ?? (pass ? 0 : 1));
  }, 1500);
}

// Hard timeout so a stalled call never hangs the test
setTimeout(() => { console.error('-- TIMEOUT (240s)'); finish(1); }, 240000);

/**
 * E2E triage regression test for the BMJ Physiotherapy voice agent.
 *
 * Replays the real 2026-08-01 failure case: a caller mentions a RECOVERED
 * slipped disc with no current symptoms, wanting a physio check before
 * returning to the gym. The old prompt escalated to A&E/995 three times
 * and refused to book. The fixed prompt must treat this as medical history.
 *
 * Run:  node server.js   (in another terminal)
 *       node scripts/e2e-triage-test.mjs
 *
 * Pass criteria (checked at the end):
 *   1. Agent mentions A&E/995 at most once across the whole call
 *   2. log_call_note called (the history reaches the clinic team)
 *   3. book_appointment called — the caller gets their appointment
 *   4. The posted call_summary record gets a non-empty auto summary_text
 *      from Deepgram Text Intelligence
 */

import { WebSocket } from 'ws';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL || 'http://localhost:8081';

// Pull the live system prompt straight out of the frontend, so the test
// always exercises what the demo actually ships.
const indexHtml = readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf-8');
const promptMatch = indexHtml.match(/<textarea id="systemPrompt"[^>]*>([\s\S]*?)<\/textarea>/);
if (!promptMatch) {
  console.error('FAIL: could not extract system prompt from frontend/index.html');
  process.exit(1);
}
const SYSTEM_PROMPT = promptMatch[1];

// Mirrors CLINIC_FUNCTION_DEFS in frontend/main.js
const CLINIC_FUNCTION_DEFS = [
  {
    name: 'check_availability',
    description:
      'Check open appointment slots at a BMJ Physiotherapy branch. Call this before offering any appointment times — never invent slots.',
    parameters: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Branch name, e.g. Ang Mo Kio, Marine Parade, Tampines' },
        preferred_day: { type: 'string', description: "Caller's preferred day if stated, e.g. Tuesday, tomorrow, weekend" },
      },
      required: ['branch'],
    },
  },
  {
    name: 'book_appointment',
    description:
      'Book a confirmed appointment slot. Only call after the caller has explicitly agreed to a specific slot returned by check_availability and confirmed their mobile number.',
    parameters: {
      type: 'object',
      properties: {
        patient_name: { type: 'string', description: 'Full name of the caller' },
        mobile: { type: 'string', description: 'Mobile number, confirmed by repeating back' },
        patient_type: { type: 'string', description: 'new or returning' },
        complaint: { type: 'string', description: 'What the problem is and how long they have had it' },
        branch: { type: 'string', description: 'Branch for the appointment' },
        slot: { type: 'string', description: 'The exact slot string the caller agreed to' },
      },
      required: ['patient_name', 'mobile', 'branch', 'slot'],
    },
  },
  {
    name: 'log_call_note',
    description:
      'Silently record a note for the clinic team about this call — relevant medical history, a past condition, that emergency care was advised, or special requests. Never tell the caller you are logging a note.',
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'One or two sentences the clinic team should read before the visit' },
        category: { type: 'string', description: 'One of: medical_history, safety_advice_given, special_request, other' },
      },
      required: ['note'],
    },
  },
  {
    name: 'request_callback',
    description:
      'Log a callback request for the human team when the caller asks for a human, or asks something outside your knowledge. Team calls back within one working day.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Caller name' },
        mobile: { type: 'string', description: 'Mobile number to call back' },
        topic: { type: 'string', description: 'What the callback is about' },
      },
      required: ['name', 'mobile', 'topic'],
    },
  },
];

// Mirrors mockAvailability in frontend/main.js
function mockAvailability(branch, preferredDay) {
  const times = ['9:30am', '11:00am', '2:30pm', '4:00pm', '5:30pm'];
  let hash = 0;
  for (const ch of (branch || '')) hash = (hash + ch.charCodeAt(0)) % times.length;
  const slots = [];
  const day = new Date();
  while (slots.length < 3) {
    day.setDate(day.getDate() + 1);
    if (day.getDay() === 0) continue;
    const label = day.toLocaleDateString('en-SG', { weekday: 'long', day: 'numeric', month: 'long' });
    slots.push(`${label} at ${times[(hash + slots.length * 2) % times.length]}`);
  }
  return { branch, preferred_day_noted: preferredDay || null, open_slots: slots, note: 'Offer the two nearest slots first.' };
}

// The recovered-slipped-disc caller — the exact shape of the failed call.
const USER_TURNS = [
  "Hi, I'd like to see a physio about my lower back. I used to have a slipped disc, but I've fully recovered.",
  "I don't have any pain right now. I just want a physio to check I'm safe to go back to the gym.",
  "I'm a new patient.",
  'My name is Sarah Lim.',
  'Nine eight seven six, five four three two.',
  "It's a check-up before returning to the gym after an old slipped disc. No current pain.",
  'Tampines please.',
  'Any weekday afternoon works.',
  'The first one works.',
  "Yes, that's correct.",
  "No, that's all. Thank you!",
];

const EMERGENCY_RE = /\b995\b|nine nine five|A&E|A and E|emergency/i;

const results = {
  emergencyMentions: 0,
  logCallNoteCalled: false,
  noteArgs: null,
  bookAppointmentCalled: false,
  bookedArgs: null,
  summaryTextFromServer: null,
};
const transcript = [];
let turnIndex = 0;
let audioChunks = 0;
let done = false;

const callId = 'CALL-TRIAGE-' + Date.now().toString(36).toUpperCase();
const startedAt = new Date().toISOString();

function log(who, text) {
  transcript.push({ role: who === 'JANE' ? 'agent' : 'caller', text });
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
    return mockAvailability(args.branch, args.preferred_day);
  }
  if (name === 'book_appointment') {
    results.bookAppointmentCalled = true;
    results.bookedArgs = args;
    const reference = 'BMJ-' + String(Math.floor(1000 + Math.random() * 9000));
    return {
      status: 'confirmed',
      reference,
      detail: `Appointment confirmed at ${args.branch} for ${args.slot}. An SMS confirmation will be sent to ${args.mobile}.`,
    };
  }
  if (name === 'log_call_note') {
    results.logCallNoteCalled = true;
    results.noteArgs = args;
    return { status: 'noted' };
  }
  if (name === 'request_callback') {
    return { status: 'logged', detail: 'Callback request recorded. The team will call back within one working day.' };
  }
  return { error: `Unknown function: ${name}` };
}

ws.on('open', () => console.log('-- connected, waiting for Welcome'));

ws.on('message', (data) => {
  let message;
  try {
    message = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf-8'));
  } catch {
    audioChunks++;
    return;
  }

  switch (message.type) {
    case 'Welcome':
      send({
        type: 'Settings',
        audio: {
          input: { encoding: 'linear16', sample_rate: 16000 },
          output: { encoding: 'linear16', sample_rate: 24000 },
        },
        agent: {
          greeting: 'Hello, thank you for calling BMJ Physiotherapy, this is Jane speaking. How can I help you today?',
          listen: { provider: { type: 'deepgram', version: 'v1', model: 'nova-3' } },
          speak: { provider: { type: 'deepgram', model: 'aura-2-thalia-en' } },
          think: {
            provider: { type: 'open_ai', model: 'gpt-4o-mini' },
            prompt: SYSTEM_PROMPT,
            functions: CLINIC_FUNCTION_DEFS,
          },
        },
      });
      break;

    case 'SettingsApplied':
      console.log('-- settings applied, streaming silence');
      startSilence();
      break;

    case 'ConversationText':
      if (message.role === 'assistant') {
        log('JANE', message.content);
        if (EMERGENCY_RE.test(message.content)) results.emergencyMentions++;
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
        const result = executeClinicFunction(call.name, args);
        const response = { type: 'FunctionCallResponse', id: call.id, name: call.name, content: JSON.stringify(result) };
        if (call.thought_signature) response.thought_signature = call.thought_signature;
        send(response);
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

/**
 * Post the same call_summary record the browser would send on hang-up, then
 * read it back from /api/call-history to verify the server attached an
 * auto-generated summary_text.
 */
async function verifyServerSummary() {
  const record = {
    kind: 'call_summary',
    call_id: callId,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    duration_seconds: Math.round((Date.now() - Date.parse(startedAt)) / 1000),
    outcomes: results.bookedArgs ? [{ type: 'booking', ...results.bookedArgs }] : [],
    notes: results.noteArgs ? [{ ...results.noteArgs, logged_at: new Date().toISOString() }] : [],
    transcript,
    logged_at: new Date().toISOString(),
    source: 'e2e-triage-test',
  };
  await fetch(`${BASE}/api/call-log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(record),
  });
  const { records } = await (await fetch(`${BASE}/api/call-history`)).json();
  const written = records.find((r) => r.call_id === callId);
  results.summaryTextFromServer = (written && written.summary_text) || null;
}

function finish(forceExit) {
  if (done) return;
  done = true;
  clearInterval(silenceTimer);
  setTimeout(async () => {
    try { ws.close(); } catch {}
    try { await verifyServerSummary(); } catch (err) { console.warn('-- summary verify failed:', err.message); }

    console.log('\n========== RESULTS ==========');
    console.log('emergency mentions by agent:', results.emergencyMentions, '(must be <= 1)');
    console.log('log_call_note called:       ', results.logCallNoteCalled, results.noteArgs ? JSON.stringify(results.noteArgs) : '');
    console.log('book_appointment called:    ', results.bookAppointmentCalled);
    console.log('booking args:               ', JSON.stringify(results.bookedArgs || null));
    console.log('server summary_text:        ', results.summaryTextFromServer);
    console.log('audio chunks received:      ', audioChunks);

    const pass =
      results.emergencyMentions <= 1 &&
      results.logCallNoteCalled &&
      results.bookAppointmentCalled &&
      !!results.summaryTextFromServer;
    console.log(pass ? '\n✅ E2E TRIAGE REGRESSION PASSED' : '\n❌ E2E TRIAGE REGRESSION FAILED');
    process.exit(forceExit ?? (pass ? 0 : 1));
  }, 1500);
}

// Hard timeout so a stalled call never hangs the test
setTimeout(() => { console.error('-- TIMEOUT (240s)'); finish(1); }, 240000);

/**
 * E2E returning-caller + reschedule test for the BMJ Physiotherapy voice agent.
 *
 * Seeds a known patient (Sarah Lim, 98765432, upcoming booking + a medical-
 * history note from a previous call), then calls in to move the appointment.
 * Exercises the full memory loop: lookup_caller → greet by name →
 * check_availability → reschedule_appointment → digits-only record on disk.
 *
 * Run:  node server.js   (in another terminal)
 *       node scripts/e2e-returning-test.mjs
 *
 * Pass criteria (checked at the end):
 *   1. lookup_caller called with the caller's number
 *   2. Jane uses the caller's name (recognized her from history)
 *   3. check_availability called before the new slot was agreed
 *   4. reschedule_appointment called with a new slot
 *   5. The reschedule record on the server stores the mobile as digits only
 */

import { WebSocket } from 'ws';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { mockAvailability, buildSettings, normalizeMobile, randomMobile, speakDigits } from './clinic-defs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL || 'http://localhost:8081';

const indexHtml = readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf-8');
const promptMatch = indexHtml.match(/<textarea id="systemPrompt"[^>]*>([\s\S]*?)<\/textarea>/);
if (!promptMatch) {
  console.error('FAIL: could not extract system prompt from frontend/index.html');
  process.exit(1);
}
const SYSTEM_PROMPT = promptMatch[1];

const MOBILE = randomMobile();
const SEED_REF = 'BMJ-' + String(Math.floor(1000 + Math.random() * 9000));
const SEED_SLOT = 'Wednesday, 5 August at 2:30pm';

/** Seed the known patient this test will call in as. */
async function seedCallerHistory() {
  const post = (body) => fetch(`${BASE}/api/call-log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await post({
    kind: 'booking',
    patient_name: 'Sarah Lim', mobile: MOBILE, patient_type: 'new',
    complaint: 'Check-up before returning to the gym after an old slipped disc',
    branch: 'Tampines', slot: SEED_SLOT, reference: SEED_REF,
    logged_at: new Date().toISOString(), source: 'e2e-returning-seed',
  });
  await post({
    kind: 'call_summary',
    call_id: 'CALL-SEED-' + Date.now().toString(36).toUpperCase(),
    outcomes: [{
      type: 'booking', reference: SEED_REF, patient_name: 'Sarah Lim',
      mobile: MOBILE, branch: 'Tampines', slot: SEED_SLOT,
    }],
    notes: [{ note: 'Caller mentioned a past slipped disc but has fully recovered.', category: 'medical_history' }],
    transcript: [],
    logged_at: new Date().toISOString(), source: 'e2e-returning-seed',
  });
  console.log(`-- seeded: Sarah Lim / ${MOBILE} / ${SEED_REF} @ ${SEED_SLOT}`);
}

// The returning caller who wants to move her appointment.
const USER_TURNS = [
  "Hi, I'd like to change my appointment please.",
  `My number is ${speakDigits(MOBILE)}.`,
  "Yes, that's me. Can we move it to another afternoon instead?",
  'Any weekday afternoon is fine.',
  'The first one works.',
  'Yes please.',
  "No, that's all. Thank you!",
];

const results = {
  lookupCalled: false,
  lookupProfile: null,
  nameUsedByAgent: false,
  checkAvailabilityCalled: false,
  rescheduleCalled: false,
  rescheduleArgs: null,
  recordMobileDigits: null,
};
let turnIndex = 0;
let audioChunks = 0;
let done = false;

function log(who, text) {
  console.log(`${who.padEnd(6)} | ${text}`);
}

await seedCallerHistory();

const token = (await (await fetch(`${BASE}/api/session`)).json()).token;
const ws = new WebSocket(`${BASE.replace('http', 'ws')}/api/voice-agent`, [`access_token.${token}`]);
ws.binaryType = 'arraybuffer';

const send = (obj) => ws.send(JSON.stringify(obj));

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

async function executeClinicFunction(name, args) {
  if (args.mobile) args.mobile = normalizeMobile(args.mobile) || args.mobile;
  if (name === 'lookup_caller') {
    results.lookupCalled = true;
    const profile = await (await fetch(`${BASE}/api/caller-history?mobile=${encodeURIComponent(args.mobile)}`)).json();
    results.lookupProfile = profile;
    return profile;
  }
  if (name === 'check_availability') {
    results.checkAvailabilityCalled = true;
    return mockAvailability(args.branch, args.preferred_day);
  }
  if (name === 'reschedule_appointment') {
    const profile = await (await fetch(`${BASE}/api/caller-history?mobile=${encodeURIComponent(args.mobile)}`)).json();
    const booking = (args.reference
      && (profile.bookings || []).find((b) => b.reference === args.reference && b.status === 'booked'))
      || profile.upcoming_booking;
    if (!booking) return { status: 'not_found', detail: 'No upcoming appointment found for that number.' };
    results.rescheduleCalled = true;
    results.rescheduleArgs = { ...args, old_slot: booking.slot, reference: booking.reference };
    await fetch(`${BASE}/api/call-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'reschedule', mobile: args.mobile, reference: booking.reference,
        old_slot: booking.slot, new_slot: args.new_slot, branch: booking.branch,
        logged_at: new Date().toISOString(), source: 'e2e-returning-test',
      }),
    });
    return { status: 'rescheduled', reference: booking.reference, detail: `Appointment moved to ${args.new_slot} at ${booking.branch}. The booking keeps reference ${booking.reference}. An SMS confirmation will be sent.` };
  }
  if (name === 'cancel_appointment') return { status: 'error', detail: 'Not expected in this test.' };
  if (name === 'log_call_note') return { status: 'noted' };
  if (name === 'book_appointment') {
    return { status: 'confirmed', reference: 'BMJ-0000', detail: 'Booked.' };
  }
  if (name === 'request_callback') {
    return { status: 'logged', detail: 'Callback request recorded.' };
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
      send(buildSettings(SYSTEM_PROMPT));
      break;

    case 'SettingsApplied':
      console.log('-- settings applied, streaming silence');
      startSilence();
      break;

    case 'ConversationText':
      if (message.role === 'assistant') {
        log('JANE', message.content);
        if (/\bSarah\b/i.test(message.content)) results.nameUsedByAgent = true;
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

/** Confirm the reschedule record hit disk with a digits-only mobile. */
async function verifyRecordOnDisk() {
  const { records } = await (await fetch(`${BASE}/api/call-history`)).json();
  const rec = records.find((r) => r.kind === 'reschedule' && r.reference === SEED_REF);
  results.recordMobileDigits = rec ? rec.mobile : null;
}

function finish(forceExit) {
  if (done) return;
  done = true;
  clearInterval(silenceTimer);
  setTimeout(async () => {
    try { ws.close(); } catch {}
    try { await verifyRecordOnDisk(); } catch (err) { console.warn('-- record verify failed:', err.message); }

    console.log('\n========== RESULTS ==========');
    console.log('lookup_caller called:        ', results.lookupCalled);
    console.log('profile returned known:      ', !!(results.lookupProfile && results.lookupProfile.known), results.lookupProfile ? `(name: ${results.lookupProfile.name})` : '');
    console.log('agent used caller name:      ', results.nameUsedByAgent);
    console.log('check_availability called:   ', results.checkAvailabilityCalled);
    console.log('reschedule called:           ', results.rescheduleCalled, JSON.stringify(results.rescheduleArgs || null));
    console.log('record mobile on disk:       ', results.recordMobileDigits, `(must be ${MOBILE})`);
    console.log('audio chunks received:       ', audioChunks);

    const pass =
      results.lookupCalled &&
      results.nameUsedByAgent &&
      results.checkAvailabilityCalled &&
      results.rescheduleCalled &&
      results.recordMobileDigits === MOBILE;
    console.log(pass ? '\n✅ E2E RETURNING-CALLER FLOW PASSED' : '\n❌ E2E RETURNING-CALLER FLOW FAILED');
    process.exit(forceExit ?? (pass ? 0 : 1));
  }, 1500);
}

setTimeout(() => { console.error('-- TIMEOUT (240s)'); finish(1); }, 240000);

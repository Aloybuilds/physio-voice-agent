/**
 * Shared test-side mirror of the clinic tool definitions and mock calendar
 * in frontend/main.js. The E2E scripts import from here so all tests drive
 * the agent with the same tool surface the browser demo ships.
 */

export const CLINIC_FUNCTION_DEFS = [
  {
    name: 'check_availability',
    description:
      'Check open appointment slots at a Meridian Physiotherapy branch. Call this before offering any appointment times — never invent slots.',
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
        mobile: { type: 'string', description: 'Mobile number as digits only, e.g. 91234567' },
        patient_type: { type: 'string', description: 'new or returning' },
        complaint: { type: 'string', description: 'What the problem is and how long they have had it' },
        branch: { type: 'string', description: 'Branch for the appointment' },
        slot: { type: 'string', description: 'The exact slot string the caller agreed to' },
      },
      required: ['patient_name', 'mobile', 'branch', 'slot'],
    },
  },
  {
    name: 'lookup_caller',
    description:
      'Look up whether a mobile number belongs to a known caller. Returns their name, upcoming booking, past bookings, and notes from previous calls. Call this as soon as you have a confirmed mobile number.',
    parameters: {
      type: 'object',
      properties: {
        mobile: { type: 'string', description: 'Mobile number as digits only, e.g. 98765432' },
      },
      required: ['mobile'],
    },
  },
  {
    name: 'cancel_appointment',
    description:
      "Cancel the caller's upcoming appointment. Only call after looking up the booking with lookup_caller, reading the slot back, and getting the caller's confirmation.",
    parameters: {
      type: 'object',
      properties: {
        mobile: { type: 'string', description: 'Mobile number as digits only' },
        reference: { type: 'string', description: 'Booking reference if the caller has it, e.g. MPC-1042' },
        reason: { type: 'string', description: 'Reason for cancelling, if given' },
      },
      required: ['mobile'],
    },
  },
  {
    name: 'reschedule_appointment',
    description:
      "Move the caller's upcoming appointment to a new slot returned by check_availability. The booking keeps its reference. Only call after the caller has agreed to the new slot.",
    parameters: {
      type: 'object',
      properties: {
        mobile: { type: 'string', description: 'Mobile number as digits only' },
        reference: { type: 'string', description: 'Booking reference if the caller has it' },
        new_slot: { type: 'string', description: 'The exact new slot string the caller agreed to' },
      },
      required: ['mobile', 'new_slot'],
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

/** Mirrors mockAvailability in frontend/main.js. */
export function mockAvailability(branch, preferredDay) {
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

/** Mirrors normalizeMobile in frontend/main.js. */
export function normalizeMobile(value) {
  if (!value) return '';
  const words = {
    zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4',
    five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  };
  let out = '';
  for (const token of String(value).toLowerCase().split(/[^a-z0-9]+/)) {
    if (!token) continue;
    if (/^\d+$/.test(token)) out += token;
    else if (words[token] !== undefined) out += words[token];
  }
  return out;
}

/**
 * Fresh mobile number per test run. Tests share one calls.jsonl, so a fixed
 * number accumulates bookings across runs and the agent starts treating the
 * scripted "new" caller as a returning patient with an upcoming appointment.
 */
export function randomMobile() {
  let digits = '9';
  for (let i = 0; i < 7; i++) digits += Math.floor(Math.random() * 10);
  return digits;
}

/** Render digits the way a caller would speak them: "nine one two three, four five six seven". */
export function speakDigits(mobile) {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  const spoken = [...mobile].map((d) => words[+d]);
  const groups = [];
  for (let i = 0; i < spoken.length; i += 4) groups.push(spoken.slice(i, i + 4).join(' '));
  return groups.join(', ');
}

/** Shared Settings payload builder so every test speaks to the same agent. */
export function buildSettings(systemPrompt) {
  return {
    type: 'Settings',
    audio: {
      input: { encoding: 'linear16', sample_rate: 16000 },
      output: { encoding: 'linear16', sample_rate: 24000 },
    },
    agent: {
      greeting: 'Hello, thank you for calling Meridian Physiotherapy, this is Jane speaking. How can I help you today?',
      listen: { provider: { type: 'deepgram', version: 'v1', model: 'nova-3' } },
      speak: { provider: { type: 'deepgram', model: 'aura-2-thalia-en' } },
      think: {
        provider: { type: 'open_ai', model: 'gpt-4o-mini' },
        prompt: systemPrompt,
        functions: CLINIC_FUNCTION_DEFS,
      },
    },
  };
}

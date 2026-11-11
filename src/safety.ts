// Crisis check runs before the model and before any checkout.
// If a message signals danger, the agent never sells: it shows help numbers.
// Numbers are the verified Kazakhstan lines from 108psy.com/pomosh.

const CRISIS_PATTERNS: RegExp[] = [
  /suicid/i,
  /kill (my|him|her)self/i,
  /end (my|it all|my life)/i,
  /self[- ]?harm/i,
  /want to die/i,
  /(don'?t|do not|no longer) want to (live|be alive|exist)/i,
  /(no reason|not worth it) to live/i,
  /better off dead/i,
  /(hurt|cut|harm) myself/i,
  /суицид/i,
  /покончить с собой/i,
  /не хочу (больше )?жить/i,
  /жить не (хочу|хочется)/i,
  /причин(ить|яю) себе (вред|боль)/i,
  /убить себя/i,
  /хочу умереть/i,
  /өзімді өлтір/i,
  /өмір сүргім келмейді/i,
  /өлгім келеді/i,
];

export const HELP_TEXT =
  'You matter, and this is a moment for a person, not a checkout. ' +
  'In Kazakhstan call 112 (emergency), 103 (ambulance), 111 (trust line) ' +
  'or 150 (youth line, also WhatsApp +7 708 106 0810). ' +
  'If you are elsewhere, please call your local emergency number.';

export function isCrisis(text: string): boolean {
  return CRISIS_PATTERNS.some((re) => re.test(text));
}

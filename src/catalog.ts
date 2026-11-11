// Server-side price list. The AI may only pick a plan id; amounts never come
// from the model or from the browser, so a prompt injection cannot change a price.

export type PlanId = 'ladder_1m' | 'ladder_3m';

export interface Plan {
  id: PlanId;
  name: string;
  days: number;
  amount: string; // USD, sandbox demo equivalent of the live KZT price
  liveKzt: number; // price on 108psy.com (paid there via Kaspi)
  note: string;
}

export const PLANS: Record<PlanId, Plan> = {
  ladder_1m: {
    id: 'ladder_1m',
    name: 'Ladder, 1 month',
    days: 30,
    amount: '39.00',
    liveKzt: 19900,
    note: '30 days of video practices for your ladder',
  },
  ladder_3m: {
    id: 'ladder_3m',
    name: 'Ladder, 3 months',
    days: 90,
    amount: '78.00',
    liveKzt: 39800,
    note: '90 days for the price of 60: the third month is free',
  },
};

export function isPlanId(value: unknown): value is PlanId {
  return value === 'ladder_1m' || value === 'ladder_3m';
}

export function planOrNull(value: unknown): Plan | null {
  return isPlanId(value) ? PLANS[value] : null;
}

// Team gifts: a company buys seats of one plan through a PayPal invoice.
// The unit price is the same catalog price; the model only picks a plan id and a seat count.
export const MIN_SEATS = 1;
export const MAX_SEATS = 200;

/** A whole number of seats in range, or null. "20", 20 and 20.0 pass; 0, 201, 2.5 and "-3" do not. */
export function cleanSeats(value: unknown): number | null {
  const n = typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= MIN_SEATS && n <= MAX_SEATS ? n : null;
}

/** Seats x unit price in cents, so 3 x 39.00 is exactly "117.00". */
export function giftTotal(plan: Plan, seats: number): string {
  const cents = Math.round(Number(plan.amount) * 100) * seats;
  return (cents / 100).toFixed(2);
}

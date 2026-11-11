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

/**
 * Cybersource sandbox test cards. Use these in staging only.
 * Reference: Cybersource test card docs — Visa 4111... always approves.
 */
export const TEST_CARDS = {
  visa_approved: {
    number: '4111111111111111',
    brand: 'visa',
    cvv: '123',
  },
  visa_declined: {
    number: '4000000000000002',
    brand: 'visa',
    cvv: '123',
  },
  mastercard_approved: {
    number: '5555555555554444',
    brand: 'mastercard',
    cvv: '123',
  },
  amex_approved: {
    number: '378282246310005',
    brand: 'amex',
    cvv: '1234',
  },
  visa_3ds_challenge: {
    number: '4000000000003220',
    brand: 'visa',
    cvv: '123',
  },
} as const;

export type TestCardKey = keyof typeof TEST_CARDS;

import { Page } from '@playwright/test';
import { BasePage } from './BasePage';
import type { PaymentMethod } from '../fixtures/testData';
import { applyPromoCode, applyGiftCard } from './payment/promoAndGiftCard';
import { selectMethod, expectPaymentError } from './payment/methodSelector';
import { fillCreditCard, submitCreditCard, CardDetails } from './payment/cybersourceCard';
import { payWithPayPal, payWithAfterpay, payWithGooglePay } from './payment/alternatePayments';

export type { CardDetails };

/**
 * KWH payment step. Cybersource CC fields live inside an iframe.
 * Promo code + gift card entry live above the method selector.
 *
 * The class is a thin facade over focused helpers in `./payment/`.
 * Public API is preserved — spec files and CheckoutFlow call these methods
 * directly.
 */
export class PaymentPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  private logMsg = (message: string): void => this.log(message);

  // ---------- Promo / gift card ----------
  async applyPromoCode(code: string): Promise<void> {
    await applyPromoCode(this.page, code);
  }

  async applyGiftCard(cardNumber: string, pin?: string): Promise<void> {
    await applyGiftCard(this.page, cardNumber, pin);
  }

  // ---------- Method selector ----------
  async selectMethod(method: PaymentMethod): Promise<void> {
    await selectMethod(this.page, this.logMsg, method);
  }

  // ---------- Cybersource (iframe) ----------
  async fillCreditCard(card: CardDetails): Promise<void> {
    await fillCreditCard(this.page, this.logMsg, card);
  }

  async submitCreditCard(): Promise<void> {
    await submitCreditCard(this.page, this.logMsg);
  }

  // ---------- PayPal (popup) ----------
  async payWithPayPal(email: string, password: string): Promise<void> {
    await payWithPayPal(this.page, email, password);
  }

  // ---------- Afterpay (redirect) ----------
  async payWithAfterpay(email: string, password: string): Promise<void> {
    await payWithAfterpay(this.page, email, password);
  }

  // ---------- Google Pay (iframe from pay.google.com) ----------
  async payWithGooglePay(): Promise<void> {
    await payWithGooglePay(this.page);
  }

  // ---------- Errors ----------
  async expectPaymentError(text: string | RegExp = /declined|failed|unable|invalid/i): Promise<void> {
    await expectPaymentError(this.page, text);
  }
}

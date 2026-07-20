import type { BuyerDetails } from '../fixtures/testData';
import type { CheckoutFlow, CheckoutFlowConfig } from './CheckoutFlow';

const OUT_OF_STOCK_ERROR_RE = /No CNC store with explicit "In stock"/i;

/**
 * CNC store selection with automatic product-swap retry. If no store
 * has the current cart product in stock (the drawer scan finds no
 * "In stock" card), clear the cart, add a different random product,
 * re-drive customer + CNC-tab + contacts + billing address, and retry.
 * Up to `maxAttempts` (default 3).
 */
export async function selectCncStoreWithProductRetry(
  flow: CheckoutFlow,
  config: CheckoutFlowConfig,
  buyer: BuyerDetails & { password?: string },
  maxAttempts = 3,
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await flow.checkout.selectFirstInStockCncStore();
      return;
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      const noInStock = OUT_OF_STOCK_ERROR_RE.test(msg);
      if (!noInStock || attempt >= maxAttempts) throw err;
      await swapProductAndReturnToStorePicker(flow, config, buyer);
    }
  }
}

async function swapProductAndReturnToStorePicker(
  flow: CheckoutFlow,
  config: CheckoutFlowConfig,
  buyer: BuyerDetails & { password?: string },
): Promise<void> {
  await flow.cart.clearCart();
  await flow.addProductsToCart(config);
  await flow.openCheckout();
  await flow.customerStep(config, buyer);
  await flow.checkout.selectClickAndCollectTab();
  await flow.checkout.fillCncPickupContact(buyer);
  await flow.checkout.fillCncBillingContact(buyer);
  await flow.checkout.pickCncBillingAddress(config.region);
}

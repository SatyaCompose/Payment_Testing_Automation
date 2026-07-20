import type { ShippingRegion } from '../../fixtures/testData';

/** ISO country code per region. Matches the ", <CODE>" suffix an
 *  address-finder API returns on suggestion labels. */
export const countryCode: Record<ShippingRegion, string> = {
  AU: 'AU',
  NZ: 'NZ',
  SG: 'SG',
};

/** Human-readable country name — used for saved-address detection and
 *  as an alternate suffix on some autocomplete providers. */
export const countryName: Record<ShippingRegion, string> = {
  AU: 'Australia',
  NZ: 'New Zealand',
  SG: 'Singapore',
};

/**
 * Per-region seed words the address autocomplete tends to resolve. AU has
 * enough coverage that a random 3-char string almost always resolves; NZ /
 * SG need specific seeds because the autocomplete corpus is sparser.
 */
export const addressSeedsByRegion: Record<ShippingRegion, readonly string[]> = {
  AU: [],
  NZ: ['unit', 'road', 'street', 'ave', 'lane'],
  // SG: expanded seeds covering common Singapore locality prefixes.
  SG: ['ger', 'jur', 'ang', 'orc', 'tam', 'bed', 'buk', 'mar', 'cle', 'wood'],
};

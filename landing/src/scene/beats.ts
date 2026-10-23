/** Story beats on the scroll-progress axis (0..1), shared by the scene and the captions. */
export const BEATS = [
  { from: 0.13, to: 0.29 }, // issue: collateral locked
  { from: 0.29, to: 0.45 }, // subscribe: stablecoins in, units out
  { from: 0.45, to: 0.66 }, // observe: Chainlink checks each date
  { from: 0.66, to: 0.82 }, // pay: coupons to holders
  { from: 0.82, to: 1.0 }, // redeem: collateral released
] as const;

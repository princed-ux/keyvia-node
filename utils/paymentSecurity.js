// utils/paymentSecurity.js
// ============================================================================
// PAYMENT VERIFICATION SECURITY HELPERS
// ----------------------------------------------------------------------------
// A gateway reporting "successful" only proves *some* money moved — it does
// NOT prove the RIGHT amount, in the RIGHT currency, for the RIGHT user.
// These helpers let every verify endpoint assert those facts before granting
// anything of value (listing activation, wallet credit, subscription).
// ============================================================================

const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
};

/**
 * Was enough money paid, in the expected currency?
 *
 * @param {object} args
 * @param {number|string} args.paidAmount       Amount the gateway says was paid
 * @param {string}        args.paidCurrency     Currency the gateway says was used
 * @param {number|string} args.expectedAmount   Amount we expect (in expectedCurrency)
 * @param {string}        args.expectedCurrency Currency we expect
 * @param {number}        [args.tolerance=0.02] Allowed shortfall ratio (2%) for
 *                                              rounding / FX / gateway fees
 * @returns {{ ok: boolean, reason?: string }}
 */
export const verifyAmountAndCurrency = ({
  paidAmount,
  paidCurrency,
  expectedAmount,
  expectedCurrency,
  tolerance = 0.02,
}) => {
  const paid = toNumber(paidAmount);
  const expected = toNumber(expectedAmount);

  if (Number.isNaN(paid) || Number.isNaN(expected)) {
    return { ok: false, reason: "Unreadable payment amount." };
  }

  if (expected <= 0) {
    return { ok: false, reason: "Invalid expected amount." };
  }

  const paidCur = String(paidCurrency || "").trim().toUpperCase();
  const expectedCur = String(expectedCurrency || "").trim().toUpperCase();

  if (!paidCur || paidCur !== expectedCur) {
    return {
      ok: false,
      reason: `Currency mismatch (paid ${paidCur || "?"}, expected ${expectedCur}).`,
    };
  }

  // Allow a small shortfall for rounding/fees, but block real underpayment.
  const minAcceptable = expected * (1 - tolerance);

  if (paid < minAcceptable) {
    return {
      ok: false,
      reason: `Underpayment (paid ${paid} ${paidCur}, expected ~${expected} ${expectedCur}).`,
    };
  }

  return { ok: true };
};

/**
 * Confirm a server-issued tx_ref actually belongs to the authenticated user.
 * Our refs embed the issuing user's id, e.g.:
 *   DIRECT-<listingId>-<userId>-<rand>
 *   FUND-<userId>-<rand>
 * Because the userId is embedded literally, a prefix/segment check is robust
 * even when ids themselves contain hyphens.
 *
 * @param {string} txRef
 * @param {string} userId
 * @returns {boolean}
 */
export const txRefBelongsToUser = (txRef, userId) => {
  if (!txRef || !userId) return false;
  // Both ref formats always carry a random suffix after the userId, so the
  // delimited `-<userId>-` segment is a reliable, false-positive-safe match.
  return String(txRef).includes(`-${userId}-`);
};

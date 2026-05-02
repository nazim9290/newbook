/**
 * billing/prorate.js — Phase 11: prorate + multi-currency helpers.
 *
 * Two responsibilities:
 *
 *   1. proratePlanChange({ oldPlan, newPlan, billingCycle, daysIntoPeriod })
 *      → returns { credit, charge, net, days_used, days_remaining }
 *      Used when an agency upgrades/downgrades mid-period.
 *
 *   2. convertCurrency({ amount, from, to, rates })
 *      → multi-currency support stub. Real FX rates fetched from
 *        a public API (Phase 11 follow-up); for now, hardcoded table
 *        in CURRENCY_RATES below — update monthly.
 *
 * No DB writes here — these are pure calculation helpers. Callers persist
 * the resulting prorated_amount + invoice line items.
 */

const CURRENCY_RATES = Object.freeze({
  // Reference: 1 unit of base = N USD
  // Update monthly. For accurate rates, replace with API call.
  USD: 1.0,
  BDT: 0.0084,    // 1 BDT ≈ $0.0084 (1 USD ≈ 119 BDT)
  JPY: 0.0064,    // 1 JPY ≈ $0.0064 (1 USD ≈ 156 JPY)
  KRW: 0.00069,   // 1 KRW ≈ $0.00069 (1 USD ≈ 1450 KRW)
  EUR: 1.05,      // 1 EUR ≈ $1.05
  INR: 0.012,     // 1 INR ≈ $0.012
  PKR: 0.0036,
  LKR: 0.0033,
});

const SUPPORTED_CURRENCIES = Object.keys(CURRENCY_RATES);

function isSupportedCurrency(code) {
  return SUPPORTED_CURRENCIES.includes((code || '').toUpperCase());
}

/**
 * Prorate plan change.
 * @param {Object} p
 * @param {Object} p.oldPlan       { price, billing_cycle: 'monthly' | 'annual' }
 * @param {Object} p.newPlan       { price, billing_cycle }
 * @param {number} p.daysIntoPeriod  How many days into the current billing period
 * @returns {{ credit: number, charge: number, net: number, days_used: number, days_remaining: number, currency: string }}
 */
function proratePlanChange({ oldPlan, newPlan, daysIntoPeriod, currency = 'BDT' }) {
  if (!oldPlan || !newPlan) throw new Error('proratePlanChange: oldPlan + newPlan required');

  const periodDays = (oldPlan.billing_cycle || 'monthly') === 'annual' ? 365 : 30;
  const days_used = Math.max(0, Math.min(periodDays, daysIntoPeriod || 0));
  const days_remaining = periodDays - days_used;

  // Daily rates
  const oldDaily = (oldPlan.price || 0) / periodDays;
  const newDaily = (newPlan.price || 0) / periodDays;

  // Credit for unused days at OLD rate
  const credit = Math.round(oldDaily * days_remaining);
  // Charge for remaining days at NEW rate
  const charge = Math.round(newDaily * days_remaining);
  // Net (positive = customer pays, negative = credit to next cycle)
  const net = charge - credit;

  return { credit, charge, net, days_used, days_remaining, currency, period_days: periodDays };
}

/**
 * Convert amount from one currency to another via USD as pivot.
 * Returns the converted amount, rounded to 2 decimals.
 */
function convertCurrency({ amount, from, to, rates = CURRENCY_RATES }) {
  if (!amount || amount === 0) return 0;
  const f = (from || '').toUpperCase();
  const t = (to || '').toUpperCase();
  if (!rates[f] || !rates[t]) {
    throw new Error(`Unsupported currency in convert: ${f} → ${t}`);
  }
  if (f === t) return amount;
  const usd = amount * rates[f];
  const dst = usd / rates[t];
  return Math.round(dst * 100) / 100;
}

/**
 * Format amount with locale-appropriate currency symbol.
 * Useful for Bengali UI:
 *   formatAmount(50000, 'BDT')  → '৳50,000'
 *   formatAmount(450, 'USD')    → '$450.00'
 */
function formatAmount(amount, currency = 'BDT') {
  const c = (currency || 'BDT').toUpperCase();
  const SYMBOLS = { USD: '$', BDT: '৳', JPY: '¥', KRW: '₩', EUR: '€', INR: '₹', PKR: '₨', LKR: 'Rs ' };
  const sym = SYMBOLS[c] || (c + ' ');
  // BDT uses Indian-style grouping in Bengali context
  const locale = c === 'BDT' || c === 'INR' ? 'en-IN' : 'en-US';
  const decimals = c === 'JPY' || c === 'KRW' ? 0 : 2;
  return sym + Number(amount).toLocaleString(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

module.exports = {
  proratePlanChange,
  convertCurrency,
  formatAmount,
  isSupportedCurrency,
  SUPPORTED_CURRENCIES,
  CURRENCY_RATES,
};

'use strict';
// Country -> LG ThinQ Connect API region (domain prefix), reused from the
// official SDK thinq-connect/pythinqconnect, thinqconnect/country.py
// (SPDX-License-Identifier: Apache-2.0, Copyright 2024 LG Electronics Inc.).
// The API host is `api-<region>.lgthinq.com`; NZ, TW, AU, KR... are all `kic`.
const REGIONS = {
  kic: ['AU', 'BD', 'CN', 'HK', 'ID', 'IN', 'JP', 'KH', 'KR', 'LA', 'LK', 'MM', 'MY', 'NP', 'NZ', 'PH', 'SG', 'TH', 'TW', 'VN'],
  aic: ['AG', 'AR', 'AW', 'BB', 'BO', 'BR', 'BS', 'BZ', 'CA', 'CL', 'CO', 'CR', 'CU', 'DM', 'DO', 'EC', 'GD', 'GT', 'GY', 'HN', 'HT', 'JM', 'KN', 'LC', 'MX', 'NI', 'PA', 'PE', 'PR', 'PY', 'SR', 'SV', 'TT', 'US', 'UY', 'VC', 'VE'],
  eic: ['AE', 'AF', 'AL', 'AM', 'AO', 'AT', 'AZ', 'BA', 'BE', 'BF', 'BG', 'BH', 'BJ', 'BY', 'CD', 'CF', 'CG', 'CH', 'CI', 'CM', 'CV', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DZ', 'EE', 'EG', 'ES', 'ET', 'FI', 'FR', 'GA', 'GB', 'GE', 'GH', 'GM', 'GN', 'GQ', 'GR', 'HR', 'HU', 'IE', 'IL', 'IQ', 'IR', 'IS', 'IT', 'JO', 'KE', 'KG', 'KW', 'KZ', 'LB', 'LR', 'LT', 'LU', 'LV', 'LY', 'MA', 'MD', 'ME', 'MK', 'ML', 'MR', 'MT', 'MU', 'MW', 'NE', 'NG', 'NL', 'NO', 'OM', 'PK', 'PL', 'PS', 'PT', 'QA', 'RO', 'RS', 'RU', 'RW', 'SA', 'SD', 'SE', 'SI', 'SK', 'SL', 'SN', 'SO', 'ST', 'SY', 'TD', 'TG', 'TN', 'TR', 'TZ', 'UA', 'UG', 'UZ', 'XK', 'YE', 'ZA', 'ZM'],
};
const COUNTRY_TO_REGION = {};
for (const [region, countries] of Object.entries(REGIONS)) {
  for (const country of countries) COUNTRY_TO_REGION[country] = region;
}
// Returns the region prefix ('kic' | 'aic' | 'eic') for a 2-letter country, or null.
function regionFor(country) {
  return COUNTRY_TO_REGION[String(country || '').trim().toUpperCase()] || null;
}
module.exports = { regionFor, REGIONS };

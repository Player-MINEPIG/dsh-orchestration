// SPDX-License-Identifier: MIT
// Deliberately synthetic provider bodies; no real accounts or credentials.
export const deepSeekFixture = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '100.5000', granted_balance: '0.5000', topped_up_balance: '100.0000' }, { currency: 'USD', total_balance: '8.00', granted_balance: '0.00', topped_up_balance: '8.00' }] };
export const alibabaFixture = { Success: true, Code: 'Success', Data: { Currency: 'CNY', AvailableAmount: '200.50', AvailableCashAmount: '180.50', CreditAmount: '20.00' }, RequestId: 'synthetic-request' };
export const metricFixture = (provider = 'deepseek', value = '100.00') => ({ provider, metrics: [{ metric: provider === 'deepseek' ? 'balance.total' : 'account.available', dimension: 'CNY', unit: 'CNY', value }] });
export const jsonResponse = value => ({ status: 200, body: Buffer.from(JSON.stringify(value)) });

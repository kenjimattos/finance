import { pluggy } from '../services/pluggy.js';

const NEW_ITEM_ID = '8226e5b2-65b2-4e93-b49e-d4cf82e9c014';

const item = await pluggy.fetchItem(NEW_ITEM_ID);
console.log('Item status:', JSON.stringify({ id: item.id, status: item.status, connector: (item as any).connector?.name }, null, 2));

let credit;
try {
  credit = await pluggy.fetchAccounts(NEW_ITEM_ID, 'CREDIT');
  console.log(`CREDIT accounts (${credit.results.length}):`);
  for (const a of credit.results) {
    console.log(`  id=${a.id}  name="${a.name}"  number="${a.number}"  type=${a.type}`);
  }
  console.log('raw:', JSON.stringify(credit, null, 2));
} catch (e) {
  console.error('CREDIT error:', e);
}

try {
  const bank = await pluggy.fetchAccounts(NEW_ITEM_ID, 'BANK');
  console.log(`BANK accounts (${bank.results.length}):`);
  for (const a of bank.results) {
    console.log(`  id=${a.id}  name="${a.name}"  number="${a.number}"  type=${a.type}`);
  }
} catch (e) {
  console.error('BANK error:', e);
}

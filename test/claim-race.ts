// Helper process for ledger.test.ts: try to claim one item, print the result.
import { Ledger } from "../src/kernel/ledger.js";

const [file, itemId, owner] = process.argv.slice(2) as [string, string, string];
const ledger = await Ledger.open(file);
console.log(JSON.stringify({ owner, claimed: await ledger.claim(itemId, owner, 60) }));
await ledger.close();

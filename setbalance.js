// Использование: node setbalance.js USER_ID КОЛИЧЕСТВО
// Пример: node setbalance.js 123456789012345678 5000
// Прибавляет указанное количество фишек к текущему балансу пользователя.
// Чтобы ОТНЯТЬ — передай отрицательное число, например -1000.

const fs = require('fs');
const DATA_FILE = './lists.json';

const userId = process.argv[2];
const amount = parseInt(process.argv[3]);

if (!userId || isNaN(amount)) {
    console.log('Использование: node setbalance.js USER_ID КОЛИЧЕСТВО');
    console.log('Пример: node setbalance.js 123456789012345678 5000');
    process.exit(1);
}

let data;
try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch (e) {
    data = { blacklist: [], whitelist: [], likes: {}, balances: {}, lastDaily: {}, redeemedPromo: [] };
}

if (!data.balances) data.balances = {};
if (typeof data.balances[userId] !== 'number') data.balances[userId] = 1000;

data.balances[userId] += amount;

fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));

console.log(`Готово! Новый баланс пользователя ${userId}: ${data.balances[userId]} 🪙`);

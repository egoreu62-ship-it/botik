// Использование: node resetbalances.js МОЙ_ID
// Обнуляет баланс ВСЕХ пользователей, кроме указанного ID.
// Пример: node resetbalances.js 123456789012345678

const fs = require('fs');
const DATA_FILE = './lists.json';

const myId = process.argv[2];

if (!myId) {
    console.log('Использование: node resetbalances.js МОЙ_ID');
    console.log('Пример: node resetbalances.js 123456789012345678');
    process.exit(1);
}

let data;
try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch (e) {
    console.log('Файл lists.json не найден или повреждён.');
    process.exit(1);
}

if (!data.balances) {
    console.log('Баланса ни у кого ещё нет, сбрасывать нечего.');
    process.exit(0);
}

let resetCount = 0;
for (const userId in data.balances) {
    if (userId !== myId) {
        data.balances[userId] = 0;
        resetCount++;
    }
}

fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));

console.log(`Готово! Обнулён баланс у ${resetCount} пользователей.`);
console.log(`Твой баланс (${myId}) не тронут: ${data.balances[myId] || 'не найден в базе'}`);

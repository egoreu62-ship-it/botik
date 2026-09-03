// Использование: node resetall.js МОЙ_ID
// Полностью обнуляет ВСЕХ пользователей (кроме указанного ID):
// - баланс фишек
// - инвентарь скинов (CS)
// - инвентарь еды/вещей
// А также обнуляет ВЕСЬ семейный банк (у всех пар, без исключений — семейный
// баланс не привязан к одному конкретному человеку, поэтому исключить
// только "своего" человека тут технически нельзя).
//
// Пример: node resetall.js 123456789012345678

const fs = require('fs');
const DATA_FILE = './lists.json';

const myId = process.argv[2];

if (!myId) {
    console.log('Использование: node resetall.js МОЙ_ID');
    process.exit(1);
}

let data;
try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch (e) {
    console.log('Файл lists.json не найден или повреждён.');
    process.exit(1);
}

let balancesReset = 0;
let inventoryReset = 0;
let generalInventoryReset = 0;

// Баланс
if (data.balances) {
    for (const userId in data.balances) {
        if (userId !== myId) {
            data.balances[userId] = 0;
            balancesReset++;
        }
    }
}

// Скины (CS-инвентарь)
if (data.inventory) {
    for (const userId in data.inventory) {
        if (userId !== myId) {
            data.inventory[userId] = [];
            inventoryReset++;
        }
    }
}

// Еда/вещи
if (data.generalInventory) {
    for (const userId in data.generalInventory) {
        if (userId !== myId) {
            data.generalInventory[userId] = {};
            generalInventoryReset++;
        }
    }
}

// Семейный банк — обнуляем полностью у всех пар
let familyBalancesReset = 0;
if (data.familyBalances) {
    for (const familyKey in data.familyBalances) {
        data.familyBalances[familyKey] = 0;
        familyBalancesReset++;
    }
}

fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));

console.log('Готово!');
console.log(`Обнулён баланс: ${balancesReset} чел.`);
console.log(`Обнулён CS-инвентарь: ${inventoryReset} чел.`);
console.log(`Обнулён инвентарь еды: ${generalInventoryReset} чел.`);
console.log(`Обнулено семейных банков: ${familyBalancesReset}`);
console.log(`Твой (${myId}) баланс не тронут.`);

// Использование: node clearinventory.js
// Полностью очищает только инвентарь скинов у всех пользователей.

const fs = require('fs');
const DATA_FILE = './lists.json';

// Чтение базы данных
let data;
try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch (e) {
    console.error('❌ Не удалось прочитать файл базы данных:', e.message);
    process.exit(1);
}

// Обнуляем исключительно инвентарь скинов из кейсов
data.inventory = {};

// Сохраняем изменения назад в файл
try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    console.log('✅ Готово! Инвентарь скинов у всех игроков успешно обнулен.');
    console.log('🛒 Продукты и маркет еды (generalInventory) остались нетронутыми.');
} catch (e) {
    console.error('❌ Ошибка при сохранении файла:', e.message);
}

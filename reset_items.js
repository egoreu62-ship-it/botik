const fs = require('fs');

const DATA_FILE = './lists.json';
const OWNER_ID = '939875876538023988'; // Твой реальный ID, который скрипт не тронет

// Проверяем, существует ли файл базы данных
if (!fs.existsSync(DATA_FILE)) {
    console.log('❌ База данных lists.json не найдена! Проверь путь к файлу.');
    process.exit(1);
}

try {
    // Читаем текущую базу данных
    const rawData = fs.readFileSync(DATA_FILE, 'utf8');
    const db = JSON.parse(rawData);

    console.log('🔄 Запуск полной очистки инвентарей, еды и семейных бюджетов...');

    // 1. Полностью обнуляем семейные бюджеты (очищаем весь объект)
    db.familyBalances = {};
    console.log('✅ Все семейные бюджеты успешно сброшены в 0.');

    // 2. Очищаем инвентари оружейных скинов (кроме владельца)
    if (db.inventory) {
        let itemsCleared = 0;
        for (const userId in db.inventory) {
            if (userId === OWNER_ID) {
                console.log(`🛡️ Твой оружейный инвентарь (${db.inventory[userId].length} скинов) успешно защищен.`);
                continue;
            }
            itemsCleared += db.inventory[userId].length;
            db.inventory[userId] = []; // Очищаем в пустой массив
        }
        console.log(`✅ Удалено ${itemsCleared} скинов оружия у обычных игроков.`);
    }

    // 3. Очищаем маркетные инвентари еды и вещей (кроме владельца)
    if (db.generalInventory) {
        let generalCleared = 0;
        for (const userId in db.generalInventory) {
            if (userId === OWNER_ID) {
                console.log(`🛡️ Твой инвентарь еды и вещей сохранен.`);
                continue;
            }
            db.generalInventory[userId] = {}; // Очищаем в пустой объект
            generalCleared++;
        }
        console.log(`✅ Полностью очищены склады продуктов у ${generalCleared} челиксов.`);
    }

    // Сохраняем обновленную базу данных обратно в файл
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
    console.log('🎉 СБРОС УСПЕШНО ЗАВЕРШЕН! База данных lists.json обновлена.');

} catch (error) {
    console.error('❌ Произошла ошибка во время выполнения скрипта:', error);
}

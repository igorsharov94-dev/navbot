"""
Telegram-бот «Навигатор без GPS».
Открывает мини-приложение с картой. Вся навигация работает внутри мини-приложения.

Запуск:
    pip install -r requirements.txt
    BOT_TOKEN=123:ABC WEBAPP_URL=https://you.github.io/navbot/ python bot.py
(или положите BOT_TOKEN и WEBAPP_URL в файл .env рядом с bot.py)
"""
import logging
import os
from pathlib import Path

from telegram import (BotCommand, InlineKeyboardButton, InlineKeyboardMarkup,
                      MenuButtonWebApp, Update, WebAppInfo)
from telegram.ext import Application, CommandHandler, ContextTypes


def load_env() -> None:
    env = Path(__file__).with_name(".env")
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_env()
TOKEN = os.environ.get("BOT_TOKEN", "")
WEBAPP_URL = os.environ.get("WEBAPP_URL", "")

logging.basicConfig(format="%(asctime)s %(levelname)s %(message)s", level=logging.INFO)
log = logging.getLogger("navbot")

START_TEXT = (
    "🚗 <b>Навігатор без GPS</b>\n\n"
    "Веде маршрутом, навіть коли під час тривоги GPS глушать або підміняють: "
    "фальшиві координати відкидаються, а положення рахується за поворотами "
    "(гіроскоп), зупинками та світлофорами.\n\n"
    "<b>Перед поїздкою:</b>\n"
    "1. Натисніть ⚙ і перевірте датчики (один раз).\n"
    "2. Закріпіть телефон у тримачі.\n"
    "3. Будуйте маршрут, поки GPS ще працює. Якщо не працює — позначте старт на мапі.\n"
    "4. Не згортайте міні-застосунок і не вимикайте екран.\n\n"
    "Натисніть кнопку нижче 👇"
)

HELP_TEXT = (
    "<b>Кнопки під час поїздки</b>\n"
    "• <b>Авто / − / +</b> — швидкість для розрахунку, коли GPS немає (крок 5 км/год).\n"
    "• <b>Проїхав поворот</b> — якщо навігатор не помітив поворот.\n"
    "• <b>Я тут</b> — натисніть на мапі, де ви. Якщо ви далеко від маршруту, він перебудується.\n"
    "• <b>Центр</b> — знову стежити за машиною.\n\n"
    "Помаранчева точка — позиція за датчиками, коло — приблизна похибка. "
    "Синя — точний GPS.\n\n"
    "Водію не торкатися екрана під час руху — кнопки для пасажира."
)


def webapp_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [[InlineKeyboardButton("🗺 Відкрити навігатор", web_app=WebAppInfo(url=WEBAPP_URL))]]
    )


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_html(START_TEXT, reply_markup=webapp_keyboard())


async def help_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_html(HELP_TEXT, reply_markup=webapp_keyboard())


async def post_init(app: Application) -> None:
    await app.bot.set_chat_menu_button(
        menu_button=MenuButtonWebApp(text="Навігатор", web_app=WebAppInfo(url=WEBAPP_URL))
    )
    await app.bot.set_my_commands(
        [BotCommand("start", "Відкрити навігатор"), BotCommand("help", "Як користуватися")]
    )
    log.info("Бот запущен, мини-приложение: %s", WEBAPP_URL)


def main() -> None:
    if not TOKEN or not WEBAPP_URL:
        raise SystemExit("Укажите BOT_TOKEN и WEBAPP_URL (в .env или переменных окружения).")
    if not WEBAPP_URL.startswith("https://"):
        raise SystemExit("WEBAPP_URL должен начинаться с https:// — так требует Telegram.")
    app = Application.builder().token(TOKEN).post_init(post_init).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("help", help_cmd))
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()

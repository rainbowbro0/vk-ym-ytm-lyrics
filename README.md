# VK, Яндекс Музыка & YouTube Music — текст песни

Три браузерных расширения, которые добавляют панель с текстом текущего трека прямо на страницу плеера.

| Расширение | Сайт |
|---|---|
| **vk-lyrics** | vk.com, vk.ru |
| **ym-lyrics** | music.yandex.ru |
| **yt-music-lyrics** | music.youtube.com |

## Источники текстов

- **VK** — встроенные тексты ВКонтакте, синхронизированные и обычные (только vk-lyrics)
- **LRCLIB** — бесплатная база синхронизированных текстов
- **Genius** — большая база, особенно русскоязычная музыка (требует токен)

Режим **Авто** перебирает источники по порядку и показывает первый найденный результат.

---

## Установка (Chromium — Chrome / Edge / Brave)

1. Скачай нужный архив со страницы [Releases](https://github.com/rainbowbro0/vk-ym-ytm-lyrics/releases/latest):
   - `vk-lyrics-chromium-X.X.X.zip`
   - `ym-lyrics-chromium-X.X.X.zip`
   - `yt-music-lyrics-chromium-X.X.X.zip`
2. Распакуй ZIP в любую папку
3. Открой `chrome://extensions/` (или `edge://extensions/`)
4. Включи **Режим разработчика** — переключатель в правом верхнем углу
5. Нажми **Загрузить распакованное** и выбери распакованную папку
6. Значок расширения появится на панели браузера

> Повтори шаги 2–5 для каждого расширения отдельно.

---

## Firefox

Расширения для Firefox появятся на [addons.mozilla.org](https://addons.mozilla.org) в ближайшем будущем.

---

## Настройка Genius

Для использования Genius нужен бесплатный токен:

1. Зайди на [genius.com/api-clients](https://genius.com/api-clients) и войди в аккаунт
2. Нажми **New API Client**, заполни название и любой URL сайта
3. Скопируй **Client Access Token**
4. Открой панель расширения на странице плеера → нажми ⚙️ → вставь токен в поле Genius

---

## Сборка из исходников

Требуется Python 3.

```bash
git clone https://github.com/rainbowbro0/vk-ym-ytm-lyrics.git
cd vk-ym-ytm-lyrics
python build.py
```

Готовые файлы появятся в папках `dist/chromium/` и `dist/firefox/` внутри каждого расширения.

## Структура репозитория

```
vk-lyrics/
├── src/                   # Общий исходный код
├── manifest.chromium.json
└── manifest.firefox.json
ym-lyrics/
├── src/
├── manifest.chromium.json
└── manifest.firefox.json
yt-music-lyrics/
├── src/
├── manifest.chromium.json
└── manifest.firefox.json
build.py                   # Скрипт сборки под оба браузера
```

# Скилл: GEO Comment Hunt

Поиск свежих постов о GEO/AI visibility и подготовка комментариев от имени Димы.

## Цель

Увеличить LinkedIn/X охват Димы как GEO-эксперта. Он комментирует свежие посты коротко и по делу — это строит экспертность и приводит трафик на reachd.ai.

## Процесс

### 1. Дедупликация
Читаем `/workspace/group/projects/reachd/geo_posts_log.txt`. Посты из этого файла пропускаем.

### 2. Поиск постов

Выполни поиск в ТРЁХ источниках обязательно:
1. **LinkedIn** — через SerpAPI
2. **Reddit** — через SerpAPI
3. **X (Twitter)** — через xAI X Search API

Из каждого источника выбери 3 самых интересных поста с наибольшим охватом (лайки, комментарии, реакции). Посты без реакций пропускай.

ВАЖНО: только настоящие посты. Статьи блогов, пресс-релизы, новостные сайты — пропускать.

Ищем посты где люди пишут про AI visibility, рекомендации бизнесов в чатботах, видимость в AI-поиске — всё, что релевантно сфере Reachd.ai.

#### LinkedIn и Reddit — через SerpAPI (Google Search)

Ключ в `$SERPAPI_API_KEY`. Сформируй 3-4 запроса для LinkedIn (`site:linkedin.com/posts`) и 2-3 для Reddit (`site:reddit.com`). Варьируй формулировки между запусками.

```bash
python3 -c "
from serpapi import GoogleSearch
import json, os
results = GoogleSearch({
    'q': '<QUERY>',
    'api_key': os.environ['SERPAPI_API_KEY'],
    'num': 10,
    'tbs': 'qdr:d'
}).get_dict()
for r in results.get('organic_results', []):
    print(json.dumps({'title': r.get('title',''), 'link': r.get('link',''), 'snippet': r.get('snippet',''), 'date': r.get('date','')}))
"
```

`tbs: qdr:d` — фильтр Google "за последний день".

#### X (Twitter) — через xAI X Search API

SerpAPI плохо ищет по X. Используй xAI Responses API с инструментом `x_search`. Ключ в `$XAI_API_KEY`.

Вычисли вчерашнюю дату для `from_date`:

```bash
YESTERDAY=$(date -d "yesterday" +%Y-%m-%d 2>/dev/null || date -v-1d +%Y-%m-%d)
TODAY=$(date +%Y-%m-%d)

curl -s https://api.x.ai/v1/responses \
  -H "Authorization: Bearer $XAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"grok-4-1-fast-reasoning\",
    \"input\": [{\"role\": \"user\", \"content\": \"Find 3 posts from the last 24 hours on X about GEO optimization, AI visibility for businesses, or how brands appear in ChatGPT/Perplexity/AI search. For each post return: author handle, full post text, and direct URL. Only real posts with engagement, skip news bots and spam.\"}],
    \"tools\": [{\"type\": \"x_search\", \"from_date\": \"$YESTERDAY\", \"to_date\": \"$TODAY\"}]
  }"
```

Ответ содержит полный текст постов, хэндлы авторов и прямые URL — дополнительно читать через curl/WebFetch не нужно. Текст поста в поле `output[last].content[0].text`.

### 3. Прочитать каждый пост целиком

ОБЯЗАТЕЛЬНО: перед тем как писать комментарий, прочитай полный текст поста через WebFetch. Сниппета из поиска НЕ ДОСТАТОЧНО. Без полного текста комментарий будет мимо.

Для каждого кандидата скачай полный текст через curl (WebFetch блокируется некоторыми сайтами):

```bash
curl -sL -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" -H "Accept: text/html,application/xhtml+xml" -H "Accept-Language: en-US,en;q=0.9" "URL" | python3 -c "
import sys, re
html = sys.stdin.read()
# Strip tags
text = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL)
text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL)
text = re.sub(r'<[^>]+>', ' ', text)
text = re.sub(r'\s+', ' ', text).strip()
print(text[:4000])
"
```

Если curl тоже не сработал (пустой ответ, login required), пропусти пост.

### 4. Отбор
Лучшие 3-5 постов (уже прочитанных!) где Димин угол добавляет реальную ценность. Приоритет:
- Только LinkedIn посты, X посты, Reddit треды
- Автор с аудиторией
- Пост делает конкретное утверждение (не просто вопрос)
- Есть что добавить по существу, зная полный контекст

### 5. Формат вывода

Для каждого поста:

```
[Автор] — [Платформа] — [тема 5 слов]
[URL как есть, без форматирования]
Почему отвечаем: [1-2 предложения по-русски]
> [готовый комментарий на английском]
```

НЕ оборачивай URL в маркдаун, бэктики или скобки. Просто URL на отдельной строке.

### 6. Правила комментариев (строго)

Представь: Дима читает пост в телефоне за кофе. Он набирает коммент за 20 секунд одним пальцем. Вот так должен звучать текст.

ЖЁСТКИЕ ЛИМИТЫ:
- Весь комментарий: максимум 35 слов. Посчитай перед отправкой
- Максимум 2 предложения. Каждое предложение максимум 20 слов
- Ноль запятых-связок ("because", "which", "and" между идеями). Одна идея, точка

ГОЛОС:
- Всегда от первого лица: "I", "I've seen", "I tracked". Никогда "we", "we've found", "what we see"
- Никогда "you", "your". Это звучит как совет незнакомцу. Говори про свой опыт, про бренды, про индустрию
- Пиши SMS другу, не абзац в статью

ЯЗЫК:
- Слова из повседневной речи. Запрещено: "consistently", "essentially", "tends to be", "in practice"
- Запрещены конструкции: "what I've found/seen is that..." — канцелярит. Просто скажи что нашёл

СОДЕРЖАНИЕ:
- Одна мысль. Одна цифра или факт. Выбери что-то одно
- Всё ТОЛЬКО в позитивной форме. Запрещены противопоставления: "not X but Y", "not only X but also Z", "less about X more about Y". Вместо этого просто скажи Y. Позитивная формулировка = говори что есть, а не чего нет
- Заканчивай размышлением вслух, как будто ещё думаешь над этим. НЕ вопросом читателю (банальные вопросы типа "Are you seeing this?" — маркер AI). Размышление = мысль, которую ты сам ещё обдумываешь

НАЧАЛО КОММЕНТАРИЯ:
- НИКОГДА не начинай с пересказа поста ("The 38% stat is...", "The two-layer model..."). Это маркер AI-контента. Живой человек сразу пишет свою мысль, а не повторяет чужую
- Начинай со своего наблюдения, факта, опыта

ЗАПРЕЩЕНО:
- Тире (—) никогда
- "you", "your" никогда
- "we", "we've" никогда. Только "I"
- "Great post!", "Love this", "This resonates", "Spot on"
- Run-on sentences с цепочкой "because... which... and... so..."
- Перечисления через запятую ("trust, backlinks, content clarity")
- Банальные вопросы в конце ("Are you seeing this?", "How are you tracking?", "Curious how...")

ТЕСТ ПЕРЕД ОТПРАВКОЙ:
1. Посчитай слова. Больше 35? Перепиши
2. Есть "you/your/we/we've"? Перепиши
3. Есть противопоставления ("not X but Y", "less X more Y")? Скажи только Y
4. Начинается с пересказа поста? Перепиши, начни со своей мысли
5. Заканчивается банальным вопросом? Замени на размышление вслух

### 7. Позиция Димы в комментариях

Основатель Reachd.ai — измеряет AI visibility, не угадывает. Ключевые тезисы:
- Большинство LLM сейчас используют веб-поиск по умолчанию, значит оптимизируем под то, что модель найдёт сегодня, а не под данные обучения полугодовой давности
- Обратная связь быстрее, чем люди думают
- Количество упоминаний — неверная метрика; важно что модель говорит, когда рекомендует бизнес в твоей категории
- LLM-посетители конвертируются лучше, потому что модель их уже убедила до клика
- SEO — первый слой (гигиена), GEO — второй слой (квалификация и рекомендация)

### 8. Обновление лога
Добавляем URL всех найденных постов в `/workspace/group/projects/reachd/geo_posts_log.txt` (по одному на строку).

### 9. Отправка
Если посты найдены — отправляем дайджест. Если нет — "Свежих постов по GEO/AI visibility не нашла."

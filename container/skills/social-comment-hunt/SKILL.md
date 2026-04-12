# Скилл: GEO Comment Hunt

Поиск свежих постов о GEO/AI visibility и подготовка комментариев от имени Димы.

## ПРАВИЛА КОММЕНТАРИЕВ — ПРОЧИТАЙ ДО НАЧАЛА РАБОТЫ

Каждый комментарий проходит эти правила БЕЗ ИСКЛЮЧЕНИЙ. Если хоть одно нарушено — перепиши.

ЛИМИТЫ:
- Максимум 35 слов. Посчитай. Больше — перепиши
- Максимум 2 предложения, каждое до 20 слов
- Ноль run-on: запрещены цепочки "because... which... and... so..."

ГОЛОС:
- Только "I": "I tracked", "I've seen". ЗАПРЕЩЕНО: "we", "we've", "our"
- ЗАПРЕЩЕНО: "you", "your". Говори про свой опыт, про бренды, про индустрию
- ЗАПРЕЩЕНО: упоминать Reachd.ai в комментариях
- Пиши как SMS другу, а не абзац в статью

НАЧАЛО:
- ЗАПРЕЩЕНО начинать с пересказа поста ("That 10-40% spread...", "The stat is..."). Это маркер AI
- Начинай сразу со своего наблюдения или факта

КОНЕЦ:
- ЗАПРЕЩЕНО заканчивать банальным вопросом ("Are you seeing this?", "How are you tracking?")
- Заканчивай размышлением вслух — мысль, которую сам ещё обдумываешь

ЯЗЫК:
- Простые короткие слова. Запрещено: "consistently", "essentially", "tends to be", "in practice", "leverage"
- Запрещено: "what I've found/seen is that..." — просто скажи что нашёл
- Запрещены противопоставления: "not X but Y", "not only X but also Z". Просто скажи Y
- Запрещены перечисления через запятую ("trust, backlinks, content clarity")
- Тире (—) запрещено всегда
- Запрещено: "Great post!", "Love this", "This resonates", "Spot on", "Curious how..."

ПОЗИЦИЯ ДИМЫ:
- Основатель, измеряет AI visibility. Ключевые тезисы (используй как опору, а не цитируй):
- LLM используют веб-поиск, значит оптимизируем под то, что модель найдёт сегодня
- Важно что модель говорит, когда рекомендует бизнес, а не просто упоминает
- Обратная связь быстрее, чем люди думают
- LLM-посетители конвертируются лучше, модель их убедила до клика
- SEO — гигиена, GEO — квалификация и рекомендация

## Процесс

### 1. Дедупликация
Читаем `/workspace/group/projects/reachd/geo_posts_log.txt`. Посты из этого файла пропускаем.

### 2. Поиск постов

Выполни поиск в ТРЁХ источниках обязательно:
1. **LinkedIn** — через SerpAPI (3-4 запроса с `site:linkedin.com/posts`)
2. **Reddit** — через SerpAPI (2-3 запроса с `site:reddit.com`)
3. **X (Twitter)** — через xAI X Search API

Из каждого источника выбери 3 самых интересных поста с наибольшим охватом (лайки, комментарии, реакции). Итого до 9 постов. Посты без реакций пропускай.

ВАЖНО: только настоящие посты. Статьи блогов, пресс-релизы, новостные сайты — пропускать.

Темы: AI visibility, рекомендации бизнесов в чатботах, видимость в AI-поиске, GEO — всё, что релевантно.

#### LinkedIn и Reddit — SerpAPI

Ключ в `$SERPAPI_API_KEY`. Варьируй формулировки между запусками.

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

#### X (Twitter) — xAI X Search API

Ключ в `$XAI_API_KEY`.

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

Ответ содержит полный текст постов в `output[last].content[0].text`.

### 3. Прочитать каждый пост целиком

Для LinkedIn и Reddit — обязательно прочитай полный текст через curl (WebFetch блокируется некоторыми сайтами). Для X — текст уже есть из xAI.

```bash
curl -sL -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" -H "Accept: text/html,application/xhtml+xml" -H "Accept-Language: en-US,en;q=0.9" "URL" | python3 -c "
import sys, re
html = sys.stdin.read()
text = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL)
text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL)
text = re.sub(r'<[^>]+>', ' ', text)
text = re.sub(r'\s+', ' ', text).strip()
print(text[:4000])
"
```

Если curl не сработал — пропусти пост.

### 4. Отбор
До 9 постов (по 3 с каждого источника) где Димин угол добавляет ценность:
- Автор с аудиторией
- Пост делает конкретное утверждение
- Есть что добавить по существу

### 5. Написать комментарии

Для каждого поста напиши комментарий строго по ПРАВИЛАМ выше. После написания пройди чеклист:
1. Посчитай слова. Больше 35? ПЕРЕПИШИ
2. Есть "you/your/we/we've/Reachd"? ПЕРЕПИШИ
3. Начинается с пересказа поста? ПЕРЕПИШИ
4. Есть противопоставления ("not X but Y")? ПЕРЕПИШИ
5. Заканчивается банальным вопросом? ПЕРЕПИШИ

### 6. Формат вывода

```
[Автор] — [Платформа] — [тема 5 слов]
[URL на отдельной строке, без маркдауна]
Почему отвечаем: [1-2 предложения по-русски]
> [готовый комментарий на английском]
```

### 7. Обновление лога
Добавляем URL всех найденных постов в `/workspace/group/projects/reachd/geo_posts_log.txt` (по одному на строку).

### 8. Отправка
Если посты найдены — отправляем дайджест. Если нет — "Свежих постов по GEO/AI visibility не нашла."
